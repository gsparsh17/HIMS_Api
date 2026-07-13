const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');

function requestId() {
  return crypto.randomUUID();
}

function timestamp() {
  return new Date().toISOString();
}

function bearer(token) {
  if (!token) return undefined;
  const value = String(token);
  return /^Bearer\s/i.test(value) ? value : `Bearer ${value}`;
}

function gatewayHeaders(accessToken, extra = {}, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'REQUEST-ID': options.requestId || requestId(),
    TIMESTAMP: options.timestamp || timestamp(),
    'X-CM-ID': options.cmId || abdmConfig.cmId,
    ...extra
  };
  if (accessToken) headers.Authorization = bearer(accessToken);
  return headers;
}

function pickRequestMetadata(req) {
  return {
    requestId: req.headers['request-id'] || req.headers['x-request-id'] || requestId(),
    timestamp: req.headers.timestamp || timestamp(),
    hipId: req.headers['x-hip-id'],
    hiuId: req.headers['x-hiu-id'],
    cmId: req.headers['x-cm-id'],
    authToken: req.headers['x-auth-token']
  };
}

module.exports = {
  requestId,
  timestamp,
  bearer,
  gatewayHeaders,
  pickRequestMetadata
};
