const crypto = require('crypto');
const platformConfig = require('../config/platform.config');
const { signRequest, stableBody } = require('../utils/internalSignature');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

async function platformRequest(path, body, options = {}) {
  platformConfig.assertPlatformConnector();
  const method = String(options.method || 'POST').toUpperCase();
  const timestamp = new Date().toISOString();
  const requestId = options.requestId || crypto.randomUUID();
  const signature = signRequest(platformConfig.connectorSecret, {
    timestamp,
    requestId,
    method,
    path,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body
  });
  const target = `${platformConfig.masterUrl}${path}`;
  const parsed = new URL(target);
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('PLATFORM_MASTER_URL must use HTTPS in production');
  }
  const response = await fetchFn(target, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-MediQliq-Platform-Tenant': platformConfig.tenantCode,
      'X-MediQliq-Platform-Key-ID': platformConfig.connectorKeyId,
      'X-MediQliq-Platform-Timestamp': timestamp,
      'X-MediQliq-Platform-Request-ID': requestId,
      'X-MediQliq-Platform-Signature': signature
    },
    body: ['GET', 'HEAD'].includes(method) ? undefined : stableBody(body),
    redirect: 'error',
    signal: AbortSignal.timeout(Number(options.timeoutMs || platformConfig.requestTimeoutMs))
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Master platform request failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

module.exports = { platformRequest };
