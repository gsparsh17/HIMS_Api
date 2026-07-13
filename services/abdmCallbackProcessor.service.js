const AbdmJob = require('../models/AbdmJob');
const AbdmTransaction = require('../models/AbdmTransaction');
const AbdmWebhookEvent = require('../models/AbdmWebhookEvent');
const { getFacility, forwardToHospital } = require('./abdmFacilityRouter.service');
const hipService = require('./abdmHip.service');
const AbdmConsent = require('../models/AbdmConsent');
const { upsertConsentFromCallback } = require('./abdmConsentStore.service');
const { pushHealthInformation } = require('./abdmDataFlow.service');

const EVENT_TO_CONNECTOR = {
  PROFILE_SHARE: '/internal/abdm/profile-share',
  HIP_LINK_TOKEN_CALLBACK: '/internal/abdm/link-token',
  HIP_CARE_CONTEXT_LINK_CALLBACK: '/internal/abdm/link-care-context',
  CARE_CONTEXT_UPDATE_CALLBACK: '/internal/abdm/care-context-update',
  SMS_NOTIFY_CALLBACK: '/internal/abdm/sms-notify',
  USER_DISCOVERY: '/internal/abdm/discover',
  USER_LINK_INIT: '/internal/abdm/link/init',
  USER_LINK_CONFIRM: '/internal/abdm/link/confirm',
  CONSENT_NOTIFY: '/internal/abdm/consent/notify',
  HEALTH_INFORMATION_REQUEST: '/internal/abdm/health-information/request',
  HIU_PATIENT_ON_SHARE: '/internal/abdm/hiu/patient/on-share'
};

const OUTBOUND_ACTIONS = {
  ACK_PROFILE_SHARE: hipService.acknowledgeProfileShare,
  RESPOND_DISCOVERY: hipService.respondDiscovery,
  RESPOND_LINK_INIT: hipService.respondLinkInit,
  RESPOND_LINK_CONFIRM: hipService.respondLinkConfirm,
  LINK_CARE_CONTEXT: hipService.linkCareContext,
  NOTIFY_CARE_CONTEXT_UPDATE: hipService.notifyCareContextUpdate,
  ACK_CONSENT: hipService.acknowledgeConsent,
  ACK_HEALTH_INFORMATION: hipService.acknowledgeHealthInformationRequest,
  NOTIFY_HEALTH_INFORMATION: hipService.notifyHealthInformation
};

async function executeOutbound(facilityId, outbound = []) {
  const results = [];
  for (const item of outbound) {
    const fn = OUTBOUND_ACTIONS[item.action];
    if (!fn) throw new Error(`Unsupported connector outbound action: ${item.action}`);
    if (item.action === 'LINK_CARE_CONTEXT') {
      results.push(await fn(facilityId, item.linkToken, item.body, item.requestId));
    } else {
      results.push(await fn(facilityId, item.body, item.requestId));
    }
  }
  return results;
}

async function processAbdmJob(job) {
  const { facilityId, eventId, eventType, body, headers, transactionDbId } = job.payload || {};
  const facility = await getFacility(facilityId);
  if (!facility) throw new Error(`No active facility mapping found for ${facilityId}`);
  const connectorPath = EVENT_TO_CONNECTOR[eventType];
  if (!connectorPath) throw new Error(`No hospital connector route configured for event ${eventType}`);

  let consent = null;
  if (eventType === 'CONSENT_NOTIFY') {
    consent = await upsertConsentFromCallback(facilityId, body);
  } else if (eventType === 'HEALTH_INFORMATION_REQUEST') {
    const consentId = body?.hiRequest?.consent?.id;
    if (consentId) consent = await AbdmConsent.findOne({ consentId, facilityId }).lean();
  }

  const connectorResponse = await forwardToHospital(
    facility,
    connectorPath,
    {
      eventType,
      body,
      headers,
      consent,
      receivedAt: job.createdAt
    },
    { requestId: job._id.toString() }
  );

  const outboundResults = await executeOutbound(facilityId, connectorResponse.outbound || []);
  let dataPushResult;
  if (connectorResponse.healthDataRequest) {
    dataPushResult = await pushHealthInformation({
      facilityId,
      ...connectorResponse.healthDataRequest
    });
  }

  if (eventId) {
    await AbdmWebhookEvent.findByIdAndUpdate(eventId, {
      processingStatus: 'COMPLETED',
      processedAt: new Date(),
      $inc: { attempts: 1 }
    });
  }
  if (transactionDbId) {
    await AbdmTransaction.findByIdAndUpdate(transactionDbId, {
      status: 'COMPLETED',
      correlation: {
        connectorResult: connectorResponse.summary,
        outboundCount: outboundResults.length
      }
    });
  }

  return { connectorResponse, outboundResults, dataPushResult };
}

async function markJobFailed(job, error) {
  const attempts = Number(job.attempts || 0) + 1;
  const dead = attempts >= Number(job.maxAttempts || 5);
  await AbdmJob.findByIdAndUpdate(job._id, {
    status: dead ? 'DEAD' : 'PENDING',
    attempts,
    runAfter: new Date(Date.now() + Math.min(2 ** attempts * 30000, 30 * 60 * 1000)),
    lastError: { message: error.message, at: new Date() },
    lockedAt: null
  });

  const eventId = job.payload?.eventId;
  if (eventId) {
    await AbdmWebhookEvent.findByIdAndUpdate(eventId, {
      processingStatus: dead ? 'FAILED' : 'RECEIVED',
      lastError: { message: error.message, at: new Date() },
      $inc: { attempts: 1 }
    });
  }
  if (job.payload?.transactionDbId) {
    await AbdmTransaction.findByIdAndUpdate(job.payload.transactionDbId, {
      status: dead ? 'FAILED' : 'PROCESSING',
      error: { message: error.message, at: new Date() }
    });
  }
}

module.exports = { processAbdmJob, markJobFailed };
