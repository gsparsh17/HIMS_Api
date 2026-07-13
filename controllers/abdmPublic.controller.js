const crypto = require('crypto');
const AbdmWebhookEvent = require('../models/AbdmWebhookEvent');
const AbdmTransaction = require('../models/AbdmTransaction');
const AbdmJob = require('../models/AbdmJob');
const abdmConfig = require('../config/abdm.config');
const { resolveFacilityId, getFacility } = require('../services/abdmFacilityRouter.service');

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function extractTransactionId(body = {}) {
  return (
    body.transactionId ||
    body.txnId ||
    body.hiRequest?.transactionId ||
    body.notification?.consentId ||
    body.consentId ||
    undefined
  );
}

function eventFlow(eventType) {
  const mapping = {
    PROFILE_SHARE: 'PROFILE_SHARE',
    HIP_LINK_TOKEN_CALLBACK: 'HIP_LINK_TOKEN',
    HIP_CARE_CONTEXT_LINK_CALLBACK: 'HIP_CARE_CONTEXT_LINK',
    CARE_CONTEXT_UPDATE_CALLBACK: 'CARE_CONTEXT_UPDATE',
    USER_DISCOVERY: 'USER_DISCOVERY',
    USER_LINK_INIT: 'USER_LINK_INIT',
    USER_LINK_CONFIRM: 'USER_LINK_CONFIRM',
    CONSENT_NOTIFY: 'CONSENT_NOTIFY',
    HEALTH_INFORMATION_REQUEST: 'HEALTH_INFORMATION_REQUEST'
  };
  return mapping[eventType] || 'OTHER';
}

function callback(eventType) {
  return async (req, res) => {
    const requestId = req.headers['request-id'] || req.headers['x-request-id'] || crypto.randomUUID();
    const transactionId = extractTransactionId(req.body);
    const payloadHash = sha256(req.body);

    try {
      const facilityId = await resolveFacilityId({
        headers: req.headers,
        body: req.body,
        requestId,
        transactionId
      });

      if (!facilityId) {
        await AbdmWebhookEvent.findOneAndUpdate(
          { eventType, requestId, payloadHash },
          {
            eventType,
            requestId,
            transactionId,
            payloadHash,
            headers: {
              'x-hip-id': req.headers['x-hip-id'],
              'x-hiu-id': req.headers['x-hiu-id'],
              'x-cm-id': req.headers['x-cm-id']
            },
            processingStatus: 'QUARANTINED',
            lastError: { message: 'Unable to resolve facility from callback', at: new Date() }
          },
          { upsert: true, new: true }
        );
        return res.status(202).json({ status: 'accepted' });
      }

      const facility = await getFacility(facilityId);
      if (!facility) {
        return res.status(202).json({ status: 'accepted' });
      }

      let event;
      try {
        event = await AbdmWebhookEvent.create({
          eventType,
          facilityId,
          requestId,
          transactionId,
          payloadHash,
          payload: abdmConfig.storeCallbackPayloads ? req.body : undefined,
          headers: {
            'x-hip-id': req.headers['x-hip-id'],
            'x-hiu-id': req.headers['x-hiu-id'],
            'x-cm-id': req.headers['x-cm-id']
          },
          processingStatus: 'RECEIVED'
        });
      } catch (error) {
        if (error.code === 11000) return res.status(202).json({ status: 'accepted', duplicate: true });
        throw error;
      }

      const transaction = await AbdmTransaction.create({
        requestId,
        transactionId,
        facilityId,
        flow: eventFlow(eventType),
        direction: 'INBOUND',
        status: 'ACCEPTED',
        correlation: { eventType },
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });

      await AbdmJob.create({
        type: 'PROCESS_ABDM_CALLBACK',
        facilityId,
        payload: {
          eventId: event._id,
          transactionDbId: transaction._id,
          facilityId,
          eventType,
          body: req.body,
          headers: {
            'request-id': req.headers['request-id'],
            timestamp: req.headers.timestamp,
            'x-hip-id': req.headers['x-hip-id'],
            'x-hiu-id': req.headers['x-hiu-id'],
            'x-cm-id': req.headers['x-cm-id'],
            'x-auth-token': req.headers['x-auth-token']
          }
        },
        runAfter: new Date()
      });

      event.processingStatus = 'ROUTED';
      await event.save();
      return res.status(202).json({ status: 'accepted' });
    } catch (error) {
      console.error(`ABDM callback ${eventType} failed:`, error);
      return res.status(202).json({ status: 'accepted' });
    }
  };
}

exports.profileShare = callback('PROFILE_SHARE');
exports.linkTokenCallback = callback('HIP_LINK_TOKEN_CALLBACK');
exports.linkCareContextCallback = callback('HIP_CARE_CONTEXT_LINK_CALLBACK');
exports.careContextUpdateCallback = callback('CARE_CONTEXT_UPDATE_CALLBACK');
exports.smsNotifyCallback = callback('SMS_NOTIFY_CALLBACK');
exports.userDiscovery = callback('USER_DISCOVERY');
exports.userLinkInit = callback('USER_LINK_INIT');
exports.userLinkConfirm = callback('USER_LINK_CONFIRM');
exports.consentNotify = callback('CONSENT_NOTIFY');
exports.healthInformationRequest = callback('HEALTH_INFORMATION_REQUEST');
exports.hiuPatientOnShare = callback('HIU_PATIENT_ON_SHARE');
