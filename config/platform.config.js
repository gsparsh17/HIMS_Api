function stripTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

const config = {
  masterUrl: stripTrailingSlash(process.env.PLATFORM_MASTER_URL || ''),
  tenantCode: String(process.env.PLATFORM_TENANT_CODE || process.env.HOSPITAL_TENANT_CODE || process.env.HOSPITAL_ID || '').trim().toUpperCase(),
  connectorKeyId: process.env.PLATFORM_CONNECTOR_KEY_ID,
  connectorSecret: process.env.PLATFORM_CONNECTOR_SECRET,
  requestMaxAgeMs: Number(process.env.PLATFORM_INTERNAL_REQUEST_MAX_AGE_MS || 5 * 60 * 1000),
  replayTtlSeconds: Number(process.env.PLATFORM_INTERNAL_REPLAY_TTL_SECONDS || 10 * 60),
  requestTimeoutMs: Number(process.env.PLATFORM_REQUEST_TIMEOUT_MS || 15000)
};

function assertPlatformInboundConnector() {
  const missing = [];
  if (!config.tenantCode) missing.push('PLATFORM_TENANT_CODE');
  if (!config.connectorKeyId) missing.push('PLATFORM_CONNECTOR_KEY_ID');
  if (!config.connectorSecret) missing.push('PLATFORM_CONNECTOR_SECRET');
  if (missing.length) throw new Error(`Hospital platform connector is missing: ${missing.join(', ')}`);
}

function assertPlatformOutboundConnector() {
  assertPlatformInboundConnector();
  if (!config.masterUrl) {
    throw new Error('Hospital platform connector is missing: PLATFORM_MASTER_URL');
  }
}

// Backward-compatible alias for callers that historically required the full
// outbound connector configuration.
function assertPlatformConnector() {
  assertPlatformOutboundConnector();
}

module.exports = {
  ...config,
  assertPlatformInboundConnector,
  assertPlatformOutboundConnector,
  assertPlatformConnector
};
