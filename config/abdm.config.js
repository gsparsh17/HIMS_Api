const ROLE_VALUES = new Set(['HOSPITAL', 'ABDM_MASTER']);

function stripTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeRole(value) {
  const role = String(value || 'HOSPITAL').trim().toUpperCase();
  return ROLE_VALUES.has(role) ? role : 'HOSPITAL';
}

const appRole = normalizeRole(process.env.APP_ROLE);
const environment = String(process.env.ABDM_ENV || 'sandbox').toLowerCase();
const isProduction = environment === 'production';

const config = {
  appRole,
  environment,
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
  facilityId: process.env.ABDM_FACILITY_ID,
  tenantCode: process.env.ABDM_TENANT_CODE,
  connectorKeyId: process.env.ABDM_CONNECTOR_KEY_ID,
  connectorSecret: process.env.ABDM_CONNECTOR_SECRET,
  masterAdminKey: process.env.ABDM_MASTER_ADMIN_KEY,
  masterEncryptionKey: process.env.ABDM_MASTER_ENCRYPTION_KEY,
  storeCallbackPayloads: String(process.env.ABDM_STORE_CALLBACK_PAYLOADS || 'false').toLowerCase() === 'true',
  callbackTimeoutMs: Number(process.env.ABDM_CONNECTOR_TIMEOUT_MS || 15000),
  internalRequestMaxAgeMs: Number(process.env.ABDM_INTERNAL_REQUEST_MAX_AGE_MS || 5 * 60 * 1000),

  featureM1: String(process.env.ABDM_ENABLE_M1 || 'true').toLowerCase() !== 'false',
  featureM2: String(process.env.ABDM_ENABLE_M2 || 'true').toLowerCase() !== 'false',
  featureM3: String(process.env.ABDM_ENABLE_M3 || 'false').toLowerCase() === 'true',

  fhirProfileBase:
    process.env.ABDM_FHIR_PROFILE_BASE || 'https://nrces.in/ndhm/fhir/r4/StructureDefinition'
};

function assertMasterCredentials() {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('ABDM_CLIENT_ID and ABDM_CLIENT_SECRET are required on the ABDM master deployment');
  }
}

function assertHospitalConnector() {
  if (!config.masterUrl || !config.facilityId || !config.connectorKeyId || !config.connectorSecret) {
    throw new Error(
      'Hospital ABDM connector requires ABDM_MASTER_URL, ABDM_FACILITY_ID, ABDM_CONNECTOR_KEY_ID and ABDM_CONNECTOR_SECRET'
    );
  }
}

module.exports = {
  ...config,
  assertMasterCredentials,
  assertHospitalConnector,
  stripTrailingSlash
};
