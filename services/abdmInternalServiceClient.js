const abdmConfig = require('../config/abdm.config');
const {
  assertSafeOutboundUrl,
  OUTBOUND_POLICIES
} = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function serviceHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  if (abdmConfig.internalServiceAuthToken) {
    headers[abdmConfig.internalServiceAuthHeader] = abdmConfig.internalServiceAuthToken;
  }
  return headers;
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean)));
}

async function trustedServiceUrl(rawUrl, { label, allowedHosts = [] } = {}) {
  const approvedHosts = unique([
    ...abdmConfig.trustedInternalServiceHosts,
    ...allowedHosts
  ]);
  return assertSafeOutboundUrl(rawUrl, {
    label: label || 'ABDM internal service URL',
    allowedHosts: approvedHosts,
    allowedPorts: abdmConfig.trustedInternalServicePorts,
    policy: OUTBOUND_POLICIES.TRUSTED_INTERNAL_SERVICE
  });
}

function safeRemoteError(result, status) {
  return {
    status,
    code: result?.code || result?.errorCode || 'INTERNAL_SERVICE_ERROR',
    message: result?.message || result?.error || `Internal service returned HTTP ${status}`,
    issues: Array.isArray(result?.errors)
      ? result.errors.slice(0, 100).map((item) => ({
          code: item?.code,
          path: item?.path,
          message: item?.message || item?.display
        }))
      : undefined
  };
}

async function readJsonWithLimit(response, maxBytes) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length && length > maxBytes) {
    const error = new Error('Internal service response exceeded the configured size limit');
    error.code = 'ABDM_INTERNAL_RESPONSE_TOO_LARGE';
    error.statusCode = 502;
    throw error;
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) {
    const error = new Error('Internal service response exceeded the configured size limit');
    error.code = 'ABDM_INTERNAL_RESPONSE_TOO_LARGE';
    error.statusCode = 502;
    throw error;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    const error = new Error('Internal service returned invalid JSON');
    error.code = 'ABDM_INTERNAL_RESPONSE_INVALID';
    error.statusCode = 502;
    throw error;
  }
}

async function requestInternalJson({
  url,
  label,
  allowedHosts,
  method = 'POST',
  body,
  timeoutMs = 30000,
  maxResponseBytes = 1024 * 1024,
  headers = {}
}) {
  const safeUrl = await trustedServiceUrl(url, { label, allowedHosts });
  let response;
  try {
    response = await fetchFn(safeUrl, {
      method,
      headers: serviceHeaders({
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    });
  } catch (cause) {
    const error = new Error(`${label || 'Internal service'} is unavailable`);
    error.code = cause?.name === 'TimeoutError'
      ? 'ABDM_INTERNAL_SERVICE_TIMEOUT'
      : 'ABDM_INTERNAL_SERVICE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const result = await readJsonWithLimit(response, maxResponseBytes);
  if (!response.ok) {
    const remote = safeRemoteError(result, response.status);
    const error = new Error(remote.message);
    error.code = remote.code;
    error.statusCode = response.status >= 500 ? 503 : response.status;
    error.details = remote;
    throw error;
  }
  return result;
}

async function checkInternalHealth({
  url,
  label,
  allowedHosts,
  timeoutMs = 5000
}) {
  if (!url) return { configured: false, healthy: false, code: 'NOT_CONFIGURED' };
  const startedAt = Date.now();
  try {
    const result = await requestInternalJson({
      url,
      label,
      allowedHosts,
      method: 'GET',
      timeoutMs,
      maxResponseBytes: 128 * 1024
    });
    return {
      configured: true,
      healthy: result.healthy !== false && result.status !== 'down',
      latencyMs: Date.now() - startedAt,
      version: result.version || null,
      package: result.package || null,
      fhirVersion: result.fhirVersion || null,
      integrityCapable: result.integrityCapable,
      trustReady: result.trustReady,
      databaseReady: result.databaseReady,
      capabilities: result.capabilities && typeof result.capabilities === 'object'
        ? Object.fromEntries(
            Object.entries(result.capabilities)
              .filter(([, value]) => typeof value === 'boolean')
              .slice(0, 50)
          )
        : undefined,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      latencyMs: Date.now() - startedAt,
      code: error.code || 'HEALTH_CHECK_FAILED',
      checkedAt: new Date().toISOString()
    };
  }
}

module.exports = {
  serviceHeaders,
  trustedServiceUrl,
  requestInternalJson,
  checkInternalHealth,
  safeRemoteError
};
