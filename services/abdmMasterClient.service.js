const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { signRequest, stableBody } = require('../utils/internalSignature');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function buildHeaders({ method, path, body, extraHeaders = {} }) {
  abdmConfig.assertHospitalConnector();
  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const signature = signRequest(abdmConfig.connectorSecret, {
    timestamp,
    requestId,
    method,
    path,
    body
  });

  return {
    'Content-Type': 'application/json',
    'X-MediQliq-Facility-ID': abdmConfig.hipId,
    'X-MediQliq-Key-ID': abdmConfig.connectorKeyId,
    'X-MediQliq-Timestamp': timestamp,
    'X-MediQliq-Request-ID': requestId,
    'X-MediQliq-Signature': signature,
    ...extraHeaders
  };
}

async function masterRequest(path, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  const body = options.body === undefined ? undefined : options.body;
  const headers = buildHeaders({ method, path, body, extraHeaders: options.headers });

  const response = await fetchFn(`${abdmConfig.masterUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : stableBody(body),
    signal: AbortSignal.timeout(Number(options.timeoutMs || abdmConfig.callbackTimeoutMs || 15000))
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `ABDM master request failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

module.exports = { masterRequest, buildHeaders };
