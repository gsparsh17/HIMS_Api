function stripTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
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

const environment = String(process.env.ABDM_ENV || 'sandbox').toLowerCase();
const isProduction = environment === 'production';
const legacyFacilityId = process.env.ABDM_FACILITY_ID;
const hfrFacilityId = process.env.ABDM_HFR_FACILITY_ID || legacyFacilityId;
const hipId = process.env.ABDM_HIP_ID || process.env.ABDM_HIP_SERVICE_ID || legacyFacilityId;
const hiuId = process.env.ABDM_HIU_ID || hipId;

const config = {
  appRole: 'HOSPITAL',
  isHospital: true,
  isMaster: false,
  environment,
  isProduction,

  masterUrl: stripTrailingSlash(process.env.ABDM_MASTER_URL || ''),
  hfrFacilityId,
  hipId,
  hiuId,
  facilityId: hipId,
  tenantCode: process.env.ABDM_TENANT_CODE,
  connectorKeyId: process.env.ABDM_CONNECTOR_KEY_ID,
  connectorSecret: process.env.ABDM_CONNECTOR_SECRET,
  hospitalEncryptionKey: process.env.ABDM_HOSPITAL_ENCRYPTION_KEY,

  callbackTimeoutMs: Number(process.env.ABDM_CONNECTOR_TIMEOUT_MS || 15000),
  internalRequestMaxAgeMs: Number(process.env.ABDM_INTERNAL_REQUEST_MAX_AGE_MS || 5 * 60 * 1000),
  internalReplayTtlSeconds: Number(process.env.ABDM_INTERNAL_REPLAY_TTL_SECONDS || 10 * 60),

  featureM1: boolEnv('ABDM_ENABLE_M1', true),
  featureM2: boolEnv('ABDM_ENABLE_M2', true),
  featureM3: boolEnv('ABDM_ENABLE_M3', true),
  featureSubscriptions: boolEnv('ABDM_ENABLE_SUBSCRIPTIONS', false),

  otpResendSeconds: Number(process.env.ABDM_OTP_RESEND_SECONDS || 60),
  otpMaxAttempts: Number(process.env.ABDM_OTP_MAX_ATTEMPTS || 5),
  identityTransactionTtlMinutes: Number(process.env.ABDM_IDENTITY_TRANSACTION_TTL_MINUTES || 30),

  fhirVersion: process.env.ABDM_FHIR_IG_VERSION || '6.5.0',
  fhirProfileBase:
    process.env.ABDM_FHIR_PROFILE_BASE ||
    'https://nrces.in/ndhm/fhir/r4/StructureDefinition',
  fhirValidatorUrl: stripTrailingSlash(process.env.ABDM_FHIR_VALIDATOR_URL || ''),
  fhirValidatorAllowedHosts: csvEnv('ABDM_FHIR_VALIDATOR_ALLOWED_HOSTS'),
  requireExternalFhirValidation: boolEnv(
    'ABDM_REQUIRE_EXTERNAL_FHIR_VALIDATION',
    isProduction
  ),

  consentValidatorUrl: stripTrailingSlash(
    process.env.ABDM_CONSENT_VALIDATOR_URL || ''
  ),
  consentValidatorAllowedHosts: csvEnv(
    'ABDM_CONSENT_VALIDATOR_ALLOWED_HOSTS'
  ),
  requireConsentValidation: boolEnv(
    'ABDM_REQUIRE_CONSENT_VALIDATION',
    isProduction
  ),

  cryptoMode: String(process.env.ABDM_CRYPTO_MODE || 'external').toLowerCase(),
  cryptoAdapterUrl: stripTrailingSlash(process.env.ABDM_CRYPTO_ADAPTER_URL || ''),
  cryptoAdapterAllowedHosts: csvEnv('ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS'),
  dataPushAllowedHosts: csvEnv('ABDM_DATA_PUSH_ALLOWED_HOSTS'),
  allowPrivateAdapterUrls: boolEnv('ABDM_ALLOW_PRIVATE_ADAPTER_URLS', false),
  allowPrivateDataPushUrls: boolEnv('ABDM_ALLOW_PRIVATE_DATA_PUSH_URLS', false),
  scanShareTokenExpirySeconds: Number(process.env.ABDM_SCAN_SHARE_TOKEN_EXPIRY_SECONDS || 1800),
  dataPushPageSize: Math.max(1, Number(process.env.ABDM_DATA_PUSH_PAGE_SIZE || 50)),
  requireCryptoIntegrity: boolEnv('ABDM_REQUIRE_CRYPTO_INTEGRITY', true)
};

function assertHospitalConnector() {
  const missing = [];
  if (!config.masterUrl) missing.push('ABDM_MASTER_URL');
  if (!config.hipId) missing.push('ABDM_HIP_ID');
  if (!config.hiuId) missing.push('ABDM_HIU_ID');
  if (!config.connectorKeyId) missing.push('ABDM_CONNECTOR_KEY_ID');
  if (!config.connectorSecret) missing.push('ABDM_CONNECTOR_SECRET');
  if (missing.length) {
    throw new Error(`Hospital ABDM connector is missing: ${missing.join(', ')}`);
  }
}

function assertEncryptionKey() {
  if (!config.hospitalEncryptionKey) {
    throw new Error('ABDM_HOSPITAL_ENCRYPTION_KEY is required');
  }
}

function assertCryptoConfiguration() {
  if (config.cryptoMode === 'external' && !config.cryptoAdapterUrl) {
    throw new Error(
      'ABDM_CRYPTO_ADAPTER_URL is required when ABDM_CRYPTO_MODE=external'
    );
  }
  if (config.isProduction && config.cryptoMode === 'mock') {
    throw new Error('ABDM_CRYPTO_MODE=mock is forbidden in production');
  }
}

module.exports = {
  ...config,
  assertHospitalConnector,
  assertEncryptionKey,
  assertCryptoConfiguration,
  stripTrailingSlash,
  boolEnv,
  csvEnv
};
