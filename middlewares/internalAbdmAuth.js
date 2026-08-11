const AbdmInternalRequest = require('../models/AbdmInternalRequest');
const abdmConfig = require('../config/abdm.config');
const { signRequest, safeEqual } = require('../utils/internalSignature');

function headers(req) {
  return {
    facilityId: req.headers['x-mediqliq-facility-id'],
    keyId: req.headers['x-mediqliq-key-id'],
    timestamp: req.headers['x-mediqliq-timestamp'],
    requestId: req.headers['x-mediqliq-request-id'],
    signature: req.headers['x-mediqliq-signature']
  };
}

function validAge(timestamp) {
  const value = new Date(timestamp).getTime();
  return (
    Number.isFinite(value) &&
    Math.abs(Date.now() - value) <= abdmConfig.internalRequestMaxAgeMs
  );
}

async function consumeRequestId(requestId) {
  try {
    await AbdmInternalRequest.create({
      requestId,
      direction: 'HOSPITAL_INBOUND',
      identity: abdmConfig.hipId,
      expiresAt: new Date(
        Date.now() + abdmConfig.internalReplayTtlSeconds * 1000
      )
    });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

async function verifyHospitalInbound(req, res, next) {
  try {
    abdmConfig.assertHospitalConnector();
    const value = headers(req);
    if (
      !value.facilityId ||
      !value.keyId ||
      !value.timestamp ||
      !value.requestId ||
      !value.signature
    ) {
      return res.status(401).json({
        error: 'Missing MediQliq connector signature headers'
      });
    }
    if (!validAge(value.timestamp)) {
      return res.status(401).json({ error: 'Connector timestamp is expired or invalid' });
    }
    const validFacility = new Set([abdmConfig.hipId, abdmConfig.hiuId]);
    if (
      !validFacility.has(value.facilityId) ||
      value.keyId !== abdmConfig.connectorKeyId
    ) {
      return res.status(401).json({
        error: 'Connector identity does not match this hospital deployment'
      });
    }

    const signedBody = ['GET', 'HEAD'].includes(String(req.method).toUpperCase())
      ? undefined
      : req.body;

    const expected = signRequest(abdmConfig.connectorSecret, {
      timestamp: value.timestamp,
      requestId: value.requestId,
      method: req.method,
      path: req.originalUrl,
      body: signedBody
    });
    if (!safeEqual(expected, value.signature)) {
      return res.status(401).json({ error: 'Invalid connector signature' });
    }
    if (!(await consumeRequestId(value.requestId))) {
      return res.status(409).json({ error: 'Duplicate connector request rejected' });
    }

    req.abdmInternalRequestId = value.requestId;
    req.abdmFacilityId = value.facilityId;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyHospitalInbound };
