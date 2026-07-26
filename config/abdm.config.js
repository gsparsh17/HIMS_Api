const ROLE_VALUES = new Set(['HOSPITAL', 'ABDM_MASTER']);

function stripTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeRole(value) {
  const role = String(value || 'HOSPITAL').trim().toUpperCase();
  return ROLE_VALUES.has(role) ? role : 'HOSPITAL';
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function csvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const appRole = normalizeRole(process.env.APP_ROLE);
const environment = String(process.env.ABDM_ENV || 'sandbox').toLowerCase();
const isProduction = environment === 'production';
const legacyFacilityId = process.env.ABDM_FACILITY_ID;
const hfrFacilityId = process.env.ABDM_HFR_FACILITY_ID || legacyFacilityId;
const hipId = process.env.ABDM_HIP_ID || legacyFacilityId;

const config = {
  appRole,
  environment,
  isProduction,
  isMaster: appRole === 'ABDM_MASTER',
  isHospital: appRole === 'HOSPITAL',

  cmId: process.env.ABDM_CM_ID || (isProduction ? 'abdm' : 'sbx'),
  clientId: process.env.ABDM_CLIENT_ID,
  clientSecret: process.env.ABDM_CLIENT_SECRET,
  bridgeId: process.env.ABDM_BRIDGE_ID || process.env.ABDM_CLIENT_ID,

  sessionUrl:
    process.env.ABDM_SESSION_URL ||
    (isProduction
      ? 'https://apis.abdm.gov.in/api/hiecm/gateway/v3/sessions'
      : 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions'),

  abhaBaseUrl: stripTrailingSlash(
    process.env.ABDM_ABHA_BASE_URL ||
      (isProduction
        ? 'https://abha.abdm.gov.in/api/abha'
        : 'https://abhasbx.abdm.gov.in/abha/api')
  ),

  hiecmBaseUrl: stripTrailingSlash(
    process.env.ABDM_HIECM_BASE_URL ||
      (isProduction ? 'https://apis.abdm.gov.in/api/hiecm' : 'https://dev.abdm.gov.in/api/hiecm')
  ),

  publicBaseUrl: stripTrailingSlash(process.env.ABDM_PUBLIC_BASE_URL || ''),
  masterUrl: stripTrailingSlash(process.env.ABDM_MASTER_URL || ''),

  // HFR identity and HIP/service identity are intentionally separate. facilityId is
  // retained as a backward-compatible alias for the actual HIP ID used in X-HIP-ID.
  hfrFacilityId,
  hipId,
  facilityId: hipId,
  tenantCode: process.env.ABDM_TENANT_CODE,
  connectorKeyId: process.env.ABDM_CONNECTOR_KEY_ID,
  connectorSecret: process.env.ABDM_CONNECTOR_SECRET,
  masterAdminKey: process.env.ABDM_MASTER_ADMIN_KEY,
  masterEncryptionKey: process.env.ABDM_MASTER_ENCRYPTION_KEY,

  storeCallbackPayloads: boolEnv('ABDM_STORE_CALLBACK_PAYLOADS', false),
  callbackTimeoutMs: Number(process.env.ABDM_CONNECTOR_TIMEOUT_MS || 15000),
  internalRequestMaxAgeMs: Number(process.env.ABDM_INTERNAL_REQUEST_MAX_AGE_MS || 5 * 60 * 1000),
  internalReplayTtlSeconds: Number(process.env.ABDM_INTERNAL_REPLAY_TTL_SECONDS || 10 * 60),

  verifyCallbackJwt: boolEnv('ABDM_VERIFY_CALLBACK_JWT', isProduction),
  callbackAllowedIps: csvEnv('ABDM_CALLBACK_ALLOWED_IPS'),

  dataPushAllowedHosts: csvEnv('ABDM_DATA_PUSH_ALLOWED_HOSTS'),
  cryptoAdapterAllowedHosts: csvEnv('ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS'),

  featureM1: boolEnv('ABDM_ENABLE_M1', true),
  featureM2: boolEnv('ABDM_ENABLE_M2', true),
  featureM3: boolEnv('ABDM_ENABLE_M3', false),

  fhirProfileBase:
    process.env.ABDM_FHIR_PROFILE_BASE || 'https://nrces.in/ndhm/fhir/r4/StructureDefinition'
};

function assertMasterCredentials() {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('ABDM_CLIENT_ID and ABDM_CLIENT_SECRET are required on the ABDM master deployment');
  }
  if (!config.bridgeId) {
    throw new Error('ABDM_BRIDGE_ID (or ABDM_CLIENT_ID) is required on the ABDM master deployment');
  }
}

function assertHospitalConnector() {
  if (!config.masterUrl || !config.hipId || !config.connectorKeyId || !config.connectorSecret) {
    throw new Error(
      'Hospital ABDM connector requires ABDM_MASTER_URL, ABDM_HIP_ID, ABDM_CONNECTOR_KEY_ID and ABDM_CONNECTOR_SECRET'
    );
  }
}

function assertSecureCallbackConfiguration() {
  if (config.isProduction && !config.verifyCallbackJwt && config.callbackAllowedIps.length === 0) {
    throw new Error(
      'Production ABDM callbacks must be protected with ABDM_VERIFY_CALLBACK_JWT=true or ABDM_CALLBACK_ALLOWED_IPS'
    );
  }
}

module.exports = {
  ...config,
  assertMasterCredentials,
  assertHospitalConnector,
  assertSecureCallbackConfiguration,
  stripTrailingSlash,
  boolEnv,
  csvEnv
};
