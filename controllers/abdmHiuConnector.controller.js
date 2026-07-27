const crypto = require('crypto');
const AbdmSubscription = require('../models/AbdmSubscription');
const {
  onConsentCallback,
  onHealthInformationRequestCallback,
  markConsentStatus
} = require('../services/abdmHiuHospital.service');
const { enqueueHiuDataPush } = require('../services/abdmHospitalJob.service');
const { configuredHospitalId } = require('../services/hospitalIdentity.service');

function payload(req) {
  return req.body?.body || {};
}

function requestId(req) {
  return (
    payload(req).request?.id ||
    payload(req).requestId ||
    payload(req).response?.requestId ||
    req.body?.headers?.['request-id'] ||
    crypto.randomUUID()
  );
}

exports.consentOnInit = async (req, res) => {
  try {
    const consent = await onConsentCallback('HIU_CONSENT_ON_INIT', payload(req));
    return res.json({
      success: true,
      summary: { consentRequestId: consent.consentRequestId, status: consent.status },
      outbound: []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.consentNotify = async (req, res) => {
  try {
    const body = payload(req);
    const consent = await onConsentCallback('HIU_CONSENT_NOTIFY', body);
    return res.json({
      success: true,
      summary: { consentId: consent.consentId, status: consent.status },
      outbound: [
        {
          action: 'HIU_ACK_CONSENT_NOTIFY',
          body: {
            acknowledgement: {
              status: 'OK',
              consentId: consent.consentId
            },
            response: { requestId: requestId(req) }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.consentOnStatus = async (req, res) => {
  try {
    const consent = await markConsentStatus(payload(req));
    return res.json({
      success: true,
      summary: consent
        ? { consentId: consent.consentId, status: consent.status }
        : { received: true },
      outbound: []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.consentOnFetch = async (req, res) => {
  try {
    const consent = await onConsentCallback('HIU_CONSENT_ON_FETCH', payload(req));
    return res.json({
      success: true,
      summary: { consentId: consent.consentId, status: consent.status },
      outbound: []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.healthInformationOnRequest = async (req, res) => {
  try {
    const request = await onHealthInformationRequestCallback(payload(req));
    return res.json({
      success: true,
      summary: request
        ? { requestId: request.requestId, transactionId: request.transactionId, status: request.status }
        : { received: true },
      outbound: []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.data = async (req, res) => {
  try {
    const job = await enqueueHiuDataPush(payload(req));
    return res.status(202).json({
      success: true,
      summary: {
        accepted: true,
        transactionId: payload(req).transactionId,
        jobId: job._id
      },
      outbound: []
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

async function updateSubscription(body, fallbackStatus) {
  const hospitalId = await configuredHospitalId();
  const officialRequestId =
    body.subscriptionRequest?.id ||
    body.subscriptionRequestId;
  const subscriptionId = body.subscription?.id || body.subscriptionId;
  const correlationRequestId =
    body.response?.requestId || body.request?.id || body.requestId;
  const status = String(
    body.status || body.subscription?.status || fallbackStatus
  ).toUpperCase();
  if (!officialRequestId && !subscriptionId && !correlationRequestId) return null;

  const candidates = [];
  if (officialRequestId) candidates.push({ subscriptionRequestId: officialRequestId });
  if (subscriptionId) candidates.push({ subscriptionId });
  if (correlationRequestId) candidates.push({ 'metadata.masterRequestId': correlationRequestId });
  const record = await AbdmSubscription.findOne({ hospitalId, $or: candidates });
  if (!record) return null;

  if (officialRequestId) record.subscriptionRequestId = officialRequestId;
  if (subscriptionId) record.subscriptionId = subscriptionId;
  record.status = ['REQUESTED', 'GRANTED', 'DENIED', 'REVOKED', 'EXPIRED', 'FAILED'].includes(status)
    ? status
    : fallbackStatus;
  record.metadata = {
    ...(record.metadata || {}),
    callback: body,
    callbackRequestId: correlationRequestId,
    lastCallbackAt: new Date()
  };
  await record.save();
  return record;
}

exports.subscriptionOnInit = async (req, res) => {
  const record = await updateSubscription(payload(req), 'REQUESTED');
  return res.json({ success: true, summary: record || { received: true }, outbound: [] });
};

exports.subscriptionNotify = async (req, res) => {
  const body = payload(req);
  const record = await updateSubscription(body, 'REQUESTED');
  const subscriptionRequestId =
    body.subscriptionRequest?.id || body.subscriptionRequestId || record?.subscriptionRequestId;
  return res.json({
    success: true,
    summary: record || { received: true },
    outbound: [
      {
        action: 'HIU_ACK_SUBSCRIPTION',
        body: {
          acknowledgement: {
            status: 'OK',
            ...(subscriptionRequestId ? { subscriptionRequestId } : {})
          },
          response: { requestId: requestId(req) }
        }
      }
    ]
  });
};

exports.subscriptionCareContextNotify = async (req, res) => {
  const body = payload(req);
  const eventId = body.event?.id || body.eventId;
  return res.json({
    success: true,
    summary: { received: true, eventId },
    outbound: [
      {
        action: 'HIU_ACK_SUBSCRIPTION_CARE_CONTEXT',
        body: {
          acknowledgement: {
            status: 'OK',
            ...(eventId ? { eventId } : {})
          },
          response: { requestId: requestId(req) }
        }
      }
    ]
  });
};
