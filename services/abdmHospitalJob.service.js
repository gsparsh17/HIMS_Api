const crypto = require('crypto');
const AbdmHospitalJob = require('../models/AbdmHospitalJob');
const abdmConfig = require('../config/abdm.config');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const AbdmCareContext = require('../models/AbdmCareContext');
const { generateAbdmHiBundle } = require('./fhir/abdmHiBundle.service');
const { toAbdmHiType } = require('../utils/abdmHiTypes');
const {
  assertConsentUsable,
  assertContextAllowed
} = require('./abdmConsentPolicy.service');
const { pushHealthInformation } = require('./abdmDataTransfer.service');
const { masterRequest } = require('./abdmMasterClient.service');
const { receiveEncryptedData } = require('./abdmHiuHospital.service');

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function enqueueJob({ hospitalId, type, idempotencyKey, payload }) {
  if (!hospitalId) throw new Error('hospitalId is required for ABDM job');
  const existing = await AbdmHospitalJob.findOne({ hospitalId, idempotencyKey });
  if (existing) {
    if (['PENDING', 'RUNNING', 'COMPLETED'].includes(existing.status)) {
      return existing;
    }

    existing.type = type;
    existing.payload = payload;
    existing.status = 'PENDING';
    existing.runAfter = new Date();
    existing.lockedAt = null;
    existing.completedAt = null;
    existing.lastError = undefined;
    existing.purgeAt = undefined;
    existing.maxAttempts = Number(
      process.env.ABDM_HOSPITAL_JOB_MAX_ATTEMPTS || existing.maxAttempts || 5
    );
    await existing.save();
    return existing;
  }

  try {
    return await AbdmHospitalJob.create({
      hospitalId,
      type,
      idempotencyKey,
      payload,
      status: 'PENDING',
      runAfter: new Date(),
      maxAttempts: Number(process.env.ABDM_HOSPITAL_JOB_MAX_ATTEMPTS || 5)
    });
  } catch (error) {
    if (error.code === 11000) {
      return AbdmHospitalJob.findOne({ hospitalId, idempotencyKey });
    }
    throw error;
  }
}

async function enqueueHipDataRequest(payload, hospitalId) {
  const transactionId = payload.hiRequest?.transactionId || payload.transactionId;
  return enqueueJob({
    hospitalId,
    type: 'PROCESS_HIP_DATA_REQUEST',
    idempotencyKey: hash(`hip:${transactionId}:${payload.hiRequest?.consent?.id}`),
    payload
  });
}

async function enqueueHiuDataPush(payload) {
  const request = await require('../models/AbdmHiuRequest').findOne({
    transactionId: payload.transactionId
  }).select('hospitalId');
  if (!request) throw new Error('Unknown HIU transaction ID');
  return enqueueJob({
    hospitalId: request.hospitalId,
    type: 'PROCESS_HIU_DATA_PUSH',
    idempotencyKey: hash(
      `hiu:${payload.transactionId}:${JSON.stringify(
        (payload.entries || []).map((entry) => entry.checksum || entry.content)
      )}`
    ),
    payload
  });
}

function notifyBody({ consentId, transactionId, status, contexts, error }) {
  return {
    notification: {
      consentId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIP', id: abdmConfig.hipId },
      statusNotification: {
        sessionStatus: status,
        statusResponses: contexts.map((context) => ({
          careContextReference: context.referenceNumber,
          hiStatus: status === 'TRANSFERRED' ? 'DELIVERED' : 'ERRORED',
          description: error || undefined
        }))
      }
    }
  };
}

async function processHipDataRequest(payload, hospitalId) {
  const consentId = payload.hiRequest?.consent?.id;
  const transactionId = payload.hiRequest?.transactionId || payload.transactionId;
  const consent = await AbdmHospitalConsent.findOne({
    hospitalId,
    role: 'HIP',
    consentId
  });
  assertConsentUsable(consent);

  const requestRefs = Array.isArray(payload.hiRequest?.careContextReference)
    ? payload.hiRequest.careContextReference
    : payload.hiRequest?.careContextReference
      ? [payload.hiRequest.careContextReference]
      : consent.careContextReferences;
  const refs = Array.from(new Set((requestRefs || []).map(String)));
  if (!refs.length) throw new Error('HI request contains no care-context references');

  const contexts = await AbdmCareContext.find({
    hospitalId,
    referenceNumber: { $in: refs },
    active: { $ne: false },
    linkStatus: 'ABDM_LINKED'
  }).lean();
  if (contexts.length !== refs.length) {
    throw new Error('One or more consented care contexts are unavailable');
  }
  contexts.forEach((context) => assertContextAllowed(consent, context));
  const patientIds = Array.from(new Set(contexts.map((item) => String(item.patientId))));
  if (patientIds.length !== 1) throw new Error('Consent maps to multiple local patients');

  const records = [];
  for (const context of contexts) {
    // eslint-disable-next-line no-await-in-loop
    const generated = await generateAbdmHiBundle(patientIds[0], {
      hiTypes: [context.hiType],
      recordReferences: context.records || [],
      careContextReference: context.referenceNumber,
      persist: false,
      hospitalId
    });
    const bundle = generated.bundles?.[context.hiType];
    if (!bundle) throw new Error(`FHIR could not be generated for ${context.referenceNumber}`);
    records.push({
      hiType: toAbdmHiType(context.hiType),
      careContextReference: context.referenceNumber,
      content: JSON.stringify(bundle)
    });
  }

  try {
    const result = await pushHealthInformation({
      hospitalId: consent.hospitalId,
      patientId: patientIds[0],
      consentId,
      transactionId,
      dataPushUrl: payload.hiRequest.dataPushUrl,
      peerKeyMaterial: payload.hiRequest.keyMaterial,
      records
    });
    await masterRequest('/internal/abdm/m2/action', {
      method: 'POST',
      body: {
        action: 'NOTIFY_HEALTH_INFORMATION',
        body: notifyBody({
          consentId,
          transactionId,
          status: 'TRANSFERRED',
          contexts
        })
      }
    });
    return result;
  } catch (error) {
    await masterRequest('/internal/abdm/m2/action', {
      method: 'POST',
      body: {
        action: 'NOTIFY_HEALTH_INFORMATION',
        body: notifyBody({
          consentId,
          transactionId,
          status: 'FAILED',
          contexts,
          error: error.message
        })
      }
    }).catch(() => {});
    throw error;
  }
}

async function processJob(job) {
  if (job.type === 'PROCESS_HIP_DATA_REQUEST') {
    return processHipDataRequest(job.payload, job.hospitalId);
  }
  if (job.type === 'PROCESS_HIU_DATA_PUSH') {
    return receiveEncryptedData(job.payload);
  }
  throw new Error(`Unsupported hospital ABDM job type: ${job.type}`);
}

module.exports = {
  enqueueHipDataRequest,
  enqueueHiuDataPush,
  processJob
};
