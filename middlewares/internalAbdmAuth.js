const AbdmFacility = require('../models/AbdmFacility');
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

async function verifyMasterInbound(req, res, next) {
  try {
    const h = getHeaders(req);
    if (!h.facilityId || !h.keyId || !h.timestamp || !h.requestId || !h.signature) {
      return res.status(401).json({ error: 'Missing MediQliq connector signature headers' });
    }
    if (!validateAge(h.timestamp)) {
      return res.status(401).json({ error: 'Connector request timestamp is expired or invalid' });
    }

    const facility = await AbdmFacility.findOne({ facilityId: h.facilityId, active: true })
      .select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');
    if (!facility || facility.connector?.status !== 'ACTIVE' || facility.connector?.keyId !== h.keyId) {
      return res.status(401).json({ error: 'Unknown or inactive facility connector' });
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

    req.abdmFacility = facility;
    req.abdmInternalRequestId = h.requestId;
    next();
  } catch (error) {
    next(error);
  }
}

function verifyHospitalInbound(req, res, next) {
  try {
    const h = getHeaders(req);
    if (!h.facilityId || !h.keyId || !h.timestamp || !h.requestId || !h.signature) {
      return res.status(401).json({ error: 'Missing MediQliq connector signature headers' });
    }
    if (!validateAge(h.timestamp)) {
      return res.status(401).json({ error: 'Connector request timestamp is expired or invalid' });
    }
    if (h.facilityId !== abdmConfig.facilityId || h.keyId !== abdmConfig.connectorKeyId) {
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

    req.abdmInternalRequestId = h.requestId;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { verifyMasterInbound, verifyHospitalInbound };
