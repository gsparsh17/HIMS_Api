const AbdmFacility = require('../models/AbdmFacility');
const AbdmInternalRequest = require('../models/AbdmInternalRequest');
const abdmConfig = require('../config/abdm.config');
const { decryptSecret } = require('../utils/secretVault');
const { signRequest, safeEqual } = require('../utils/internalSignature');

function getHeaders(req) {
  return {
    facilityId: req.headers['x-mediqliq-facility-id'],
    keyId: req.headers['x-mediqliq-key-id'],
    timestamp: req.headers['x-mediqliq-timestamp'],
    requestId: req.headers['x-mediqliq-request-id'],
    signature: req.headers['x-mediqliq-signature']
  };
}

function validateAge(timestamp) {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return false;
  return Math.abs(Date.now() - time) <= abdmConfig.internalRequestMaxAgeMs;
}

async function consumeRequestId({ requestId, direction, identity }) {
  try {
    await AbdmInternalRequest.create({
      requestId,
      direction,
      identity,
      expiresAt: new Date(Date.now() + abdmConfig.internalReplayTtlSeconds * 1000)
    });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

async function findFacilityByHipId(hipId) {
  return AbdmFacility.findOne({
    active: true,
    $or: [{ 'abdm.hipId': hipId }, { facilityId: hipId }]
  }).select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');
}

async function verifyMasterInbound(req, res, next) {
  try {
    const h = getHeaders(req);
    if (!h.facilityId || !h.keyId || !h.timestamp || !h.requestId || !h.signature) {
      return res.status(401).json({ error: 'Missing MediQliq connector signature headers' });
    }
    if (!validateAge(h.timestamp)) {
      return res.status(401).json({ error: 'Connector request timestamp is expired or invalid' });
    }

    const facility = await findFacilityByHipId(h.facilityId);
    const connectorStatus = facility?.connector?.status;
    const pendingAllowedPath = req.originalUrl.startsWith('/internal/abdm/facility-status');
    const allowedStatus = connectorStatus === 'ACTIVE' || (connectorStatus === 'PENDING' && pendingAllowedPath);
    if (!facility || !allowedStatus || facility.connector?.keyId !== h.keyId) {
      return res.status(401).json({ error: 'Unknown, inactive, or not-yet-activated facility connector' });
    }

    const secret = decryptSecret(facility.connector.secretEncrypted);
    const expected = signRequest(secret, {
      timestamp: h.timestamp,
      requestId: h.requestId,
      method: req.method,
      path: req.originalUrl,
      body: req.body
    });
    if (!safeEqual(expected, h.signature)) {
      return res.status(401).json({ error: 'Invalid connector signature' });
    }

    const accepted = await consumeRequestId({
      requestId: h.requestId,
      direction: 'MASTER_INBOUND',
      identity: h.facilityId
    });
    if (!accepted) return res.status(409).json({ error: 'Duplicate connector request rejected' });

    req.abdmFacility = facility;
    req.abdmInternalRequestId = h.requestId;
    return next();
  } catch (error) {
    return next(error);
  }
}

async function verifyHospitalInbound(req, res, next) {
  try {
    const h = getHeaders(req);
    if (!h.facilityId || !h.keyId || !h.timestamp || !h.requestId || !h.signature) {
      return res.status(401).json({ error: 'Missing MediQliq connector signature headers' });
    }
    if (!validateAge(h.timestamp)) {
      return res.status(401).json({ error: 'Connector request timestamp is expired or invalid' });
    }
    if (h.facilityId !== abdmConfig.hipId || h.keyId !== abdmConfig.connectorKeyId) {
      return res.status(401).json({ error: 'Connector identity does not match this hospital deployment' });
    }

    const expected = signRequest(abdmConfig.connectorSecret, {
      timestamp: h.timestamp,
      requestId: h.requestId,
      method: req.method,
      path: req.originalUrl,
      body: req.body
    });
    if (!safeEqual(expected, h.signature)) {
      return res.status(401).json({ error: 'Invalid connector signature' });
    }

    const accepted = await consumeRequestId({
      requestId: h.requestId,
      direction: 'HOSPITAL_INBOUND',
      identity: h.facilityId
    });
    if (!accepted) return res.status(409).json({ error: 'Duplicate connector request rejected' });

    req.abdmInternalRequestId = h.requestId;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyMasterInbound, verifyHospitalInbound };
