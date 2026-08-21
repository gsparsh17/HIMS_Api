const platformConfig = require('../config/platform.config');
const PlatformInternalRequest = require('../models/PlatformInternalRequest');
const { signRequest, safeEqual } = require('../utils/internalSignature');

function headers(req) {
  return {
    tenantCode: req.headers['x-mediqliq-platform-tenant'],
    keyId: req.headers['x-mediqliq-platform-key-id'],
    timestamp: req.headers['x-mediqliq-platform-timestamp'],
    requestId: req.headers['x-mediqliq-platform-request-id'],
    signature: req.headers['x-mediqliq-platform-signature']
  };
}

function validAge(timestamp) {
  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && Math.abs(Date.now() - value) <= platformConfig.requestMaxAgeMs;
}

async function consumeRequestId(requestId) {
  try {
    await PlatformInternalRequest.create({
      requestId,
      identity: platformConfig.tenantCode,
      expiresAt: new Date(Date.now() + platformConfig.replayTtlSeconds * 1000)
    });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

async function verifyPlatformInbound(req, res, next) {
  try {
    platformConfig.assertPlatformConnector();
    const h = headers(req);
    if (!h.tenantCode || !h.keyId || !h.timestamp || !h.requestId || !h.signature) {
      return res.status(401).json({ success: false, error: 'Missing MediQliq platform signature headers' });
    }
    if (!validAge(h.timestamp)) return res.status(401).json({ success: false, error: 'Platform request timestamp is expired or invalid' });
    if (String(h.tenantCode).toUpperCase() !== platformConfig.tenantCode || h.keyId !== platformConfig.connectorKeyId) {
      return res.status(401).json({ success: false, error: 'Platform connector identity does not match this hospital deployment' });
    }
    const body = ['GET', 'HEAD'].includes(String(req.method).toUpperCase()) ? undefined : req.body;
    const expected = signRequest(platformConfig.connectorSecret, {
      timestamp: h.timestamp,
      requestId: h.requestId,
      method: req.method,
      path: req.originalUrl,
      body
    });
    if (!safeEqual(expected, h.signature)) return res.status(401).json({ success: false, error: 'Invalid platform connector signature' });
    if (!(await consumeRequestId(h.requestId))) return res.status(409).json({ success: false, error: 'Duplicate platform request rejected' });
    req.platformRequestId = h.requestId;
    req.platformTenantCode = platformConfig.tenantCode;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyPlatformInbound };
