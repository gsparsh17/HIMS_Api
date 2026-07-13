const crypto = require('crypto');
const { readiness } = require('../utils/abdmOnboarding');
const abdmConfig = require('../config/abdm.config');
const { abhaRequest } = require('../services/abdmHttp.service');
const {
  generateLinkToken,
  linkCareContext,
  notifyCareContextUpdate,
  respondDiscovery,
  respondLinkInit,
  respondLinkConfirm,
  acknowledgeConsent,
  acknowledgeHealthInformationRequest,
  notifyHealthInformation,
  acknowledgeProfileShare
} = require('../services/abdmHip.service');
const AbdmTransaction = require('../models/AbdmTransaction');

const ALLOWED_ABHA_REQUESTS = new Set([
  'GET /v3/profile/public/certificate',
  'POST /v3/enrollment/request/otp',
  'POST /v3/enrollment/enrol/byAadhaar',
  'POST /v3/enrollment/auth/byAbdm',
  'POST /v3/profile/account/abha/search',
  'POST /v3/profile/login/request/otp',
  'POST /v3/profile/login/verify',
  'GET /v3/profile/account/qrCode',
  'GET /v3/profile/account/abha-card'
]);

function isAllowedAbhaRequest(method, path) {
  return ALLOWED_ABHA_REQUESTS.has(`${String(method || 'GET').toUpperCase()} ${String(path || '')}`);
}

exports.proxyAbha = async (req, res) => {
  try {
    const { method = 'GET', path, body, headers = {}, responseType = 'json' } = req.body || {};
    if (!isAllowedAbhaRequest(method, path)) {
      return res.status(400).json({ error: 'ABHA path is not allow-listed by the ABDM master proxy' });
    }

    const safeHeaders = {};
    if (headers['X-token'] || headers['x-token']) safeHeaders['X-token'] = headers['X-token'] || headers['x-token'];

    const data = await abhaRequest(path, {
      method: String(method).toUpperCase(),
      body,
      headers: safeHeaders,
      responseType
    });

    if (responseType === 'buffer') {
      return res.json({
        success: true,
        dataBase64: data.buffer.toString('base64'),
        contentType: data.contentType
      });
    }
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

async function createTransaction(facilityId, flow, requestId, status = 'WAITING_CALLBACK', correlation = {}) {
  return AbdmTransaction.create({
    requestId,
    facilityId,
    flow,
    direction: 'OUTBOUND',
    status,
    correlation,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
}

exports.hipAction = async (req, res) => {
  try {
    const facilityId = req.abdmFacility.abdm?.hipId || req.abdmFacility.facilityId;
    const { action, body, linkToken } = req.body || {};
    const requestId = crypto.randomUUID();
    let result;
    let flow = 'OTHER';

    switch (action) {
      case 'GENERATE_LINK_TOKEN':
        result = await generateLinkToken(facilityId, body, requestId);
        flow = 'HIP_LINK_TOKEN';
        break;
      case 'LINK_CARE_CONTEXT':
        if (!linkToken) return res.status(400).json({ error: 'linkToken is required' });
        result = await linkCareContext(facilityId, linkToken, body, requestId);
        flow = 'HIP_CARE_CONTEXT_LINK';
        break;
      case 'NOTIFY_CARE_CONTEXT_UPDATE':
        result = await notifyCareContextUpdate(facilityId, body, requestId);
        flow = 'CARE_CONTEXT_UPDATE';
        break;
      case 'RESPOND_DISCOVERY':
        result = await respondDiscovery(facilityId, body, requestId);
        flow = 'USER_DISCOVERY';
        break;
      case 'RESPOND_LINK_INIT':
        result = await respondLinkInit(facilityId, body, requestId);
        flow = 'USER_LINK_INIT';
        break;
      case 'RESPOND_LINK_CONFIRM':
        result = await respondLinkConfirm(facilityId, body, requestId);
        flow = 'USER_LINK_CONFIRM';
        break;
      case 'ACK_CONSENT':
        result = await acknowledgeConsent(facilityId, body, requestId);
        flow = 'CONSENT_NOTIFY';
        break;
      case 'ACK_HEALTH_INFORMATION':
        result = await acknowledgeHealthInformationRequest(facilityId, body, requestId);
        flow = 'HEALTH_INFORMATION_REQUEST';
        break;
      case 'NOTIFY_HEALTH_INFORMATION':
        result = await notifyHealthInformation(facilityId, body, requestId);
        flow = 'HEALTH_INFORMATION_PUSH';
        break;
      case 'ACK_PROFILE_SHARE':
        result = await acknowledgeProfileShare(facilityId, body, requestId);
        flow = 'PROFILE_SHARE';
        break;
      default:
        return res.status(400).json({ error: `Unsupported HIP action: ${action}` });
    }

    await createTransaction(facilityId, flow, requestId, 'WAITING_CALLBACK', {
      internalRequestId: req.abdmInternalRequestId,
      action
    });

    return res.status(202).json({ success: true, requestId, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

exports.health = async (req, res) => {
  res.json({
    success: true,
    role: abdmConfig.appRole,
    environment: abdmConfig.environment,
    hfrFacilityId: req.abdmFacility?.hfr?.facilityId || abdmConfig.hfrFacilityId,
    hipId: req.abdmFacility?.abdm?.hipId || req.abdmFacility?.facilityId || abdmConfig.hipId,
    facilityId: req.abdmFacility?.abdm?.hipId || req.abdmFacility?.facilityId || abdmConfig.hipId,
    timestamp: new Date().toISOString()
  });
};

exports.facilityStatus = async (req, res) => {
  const facility = req.abdmFacility;
  return res.json({
    success: true,
    facility: {
      hfr: facility.hfr,
      abdm: facility.abdm,
      tenantCode: facility.tenantCode,
      connector: {
        baseUrl: facility.connector?.baseUrl,
        keyId: facility.connector?.keyId,
        status: facility.connector?.status,
        lastHealthCheckAt: facility.connector?.lastHealthCheckAt,
        lastHealthCheckStatus: facility.connector?.lastHealthCheckStatus
      },
      onboardingStatus: facility.onboardingStatus,
      rollout: facility.rollout,
      scanAndShare: facility.scanAndShare,
      active: facility.active,
      readiness: readiness(facility)
    }
  });
};
