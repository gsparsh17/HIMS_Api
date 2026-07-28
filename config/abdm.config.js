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

function intCsvEnv(name) {
  return csvEnv(name)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0 && item <= 65535);
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

  fhirVersion: process.env.ABDM_FHIR_IG_VERSION || process.env.ABDM_FHIR_PACKAGE_VERSION || '6.5.0',
  fhirR4Version: process.env.ABDM_FHIR_VERSION || '4.0.1',
  fhirPackage: process.env.ABDM_FHIR_PACKAGE || 'ndhm.in#6.5.0',
  fhirPackageChecksum: process.env.ABDM_FHIR_PACKAGE_CHECKSUM || '',
  fhirProfileBase:
    process.env.ABDM_FHIR_PROFILE_BASE ||
    'https://nrces.in/ndhm/fhir/r4/StructureDefinition',
  fhirValidatorUrl: stripTrailingSlash(process.env.ABDM_FHIR_VALIDATOR_URL || ''),
  fhirValidatorMode: String(process.env.ABDM_FHIR_VALIDATOR_MODE || 'hapi-wrapper').toLowerCase(),
  fhirValidatorAllowedHosts: csvEnv('ABDM_FHIR_VALIDATOR_ALLOWED_HOSTS'),
  fhirValidatorHealthUrl: stripTrailingSlash(process.env.ABDM_FHIR_VALIDATOR_HEALTH_URL || ''),
  fhirValidatorTimeoutMs: Number(process.env.ABDM_FHIR_VALIDATOR_TIMEOUT_MS || 30000),
  fhirValidatorMaxResponseBytes: Number(process.env.ABDM_FHIR_VALIDATOR_MAX_RESPONSE_BYTES || 1024 * 1024),
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
  consentValidatorHealthUrl: stripTrailingSlash(process.env.ABDM_CONSENT_VALIDATOR_HEALTH_URL || ''),
  consentValidatorTimeoutMs: Number(process.env.ABDM_CONSENT_VALIDATOR_TIMEOUT_MS || 15000),
  requireConsentValidation: boolEnv(
    'ABDM_REQUIRE_CONSENT_VALIDATION',
    isProduction
  ),

  cryptoMode: String(process.env.ABDM_CRYPTO_MODE || 'external').toLowerCase(),
  cryptoAdapterUrl: stripTrailingSlash(process.env.ABDM_CRYPTO_ADAPTER_URL || ''),
  cryptoAdapterAllowedHosts: csvEnv('ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS'),
  cryptoAdapterHealthUrl: stripTrailingSlash(process.env.ABDM_CRYPTO_ADAPTER_HEALTH_URL || ''),
  cryptoAdapterTimeoutMs: Number(process.env.ABDM_CRYPTO_ADAPTER_TIMEOUT_MS || 30000),
  dataPushAllowedHosts: csvEnv('ABDM_DATA_PUSH_ALLOWED_HOSTS'),
  allowPrivateAdapterUrls: boolEnv('ABDM_ALLOW_PRIVATE_ADAPTER_URLS', false),
  trustedInternalServiceHosts: csvEnv('ABDM_TRUSTED_INTERNAL_SERVICE_HOSTS'),
  trustedInternalServicePorts: intCsvEnv('ABDM_TRUSTED_INTERNAL_SERVICE_PORTS'),
  internalServiceNetworkMode: String(process.env.ABDM_INTERNAL_SERVICE_NETWORK_MODE || 'private-mtls').toLowerCase(),
  internalServiceAuthHeader: process.env.ABDM_INTERNAL_SERVICE_AUTH_HEADER || 'X-MediQliq-Service-Token',
  internalServiceAuthToken: process.env.ABDM_INTERNAL_SERVICE_AUTH_TOKEN || '',
  allowPrivateDataPushUrls: boolEnv('ABDM_ALLOW_PRIVATE_DATA_PUSH_URLS', false),
  scanShareTokenExpirySeconds: Number(process.env.ABDM_SCAN_SHARE_TOKEN_EXPIRY_SECONDS || 1800),
  dataPushPageSize: Math.max(1, Number(process.env.ABDM_DATA_PUSH_PAGE_SIZE || 50)),
  requireCryptoIntegrity: boolEnv('ABDM_REQUIRE_CRYPTO_INTEGRITY', true),

  packetFeatureEnabled: boolEnv('ABDM_PACKET_FEATURE_ENABLED', true),
  packetDefaultReviewPolicy: String(
    process.env.ABDM_PACKET_DEFAULT_REVIEW_POLICY || 'REQUIRED_BEFORE_TRANSFER'
  ).toUpperCase(),
  packetStorePlaintext: boolEnv('ABDM_PACKET_STORE_PLAINTEXT', false),
  packetRawFhirRoles: csvEnv('ABDM_PACKET_RAW_FHIR_ROLES').map((item) => item.toLowerCase()),
  packetApproverRoles: csvEnv('ABDM_PACKET_APPROVER_ROLES').map((item) => item.toLowerCase()),
  packetMaxSources: Math.max(1, Number(process.env.ABDM_PACKET_MAX_SOURCES || 500)),
  packetMaxBundleBytes: Math.max(1024, Number(process.env.ABDM_PACKET_MAX_BUNDLE_BYTES || 20 * 1024 * 1024)),
  dependencyHealthTtlSeconds: Math.max(10, Number(process.env.ABDM_DEPENDENCY_HEALTH_TTL_SECONDS || 120))
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

function assertProfileConfiguration() {
  if (config.fhirR4Version !== '4.0.1') {
    throw new Error('ABDM_FHIR_VERSION must remain pinned to FHIR R4 4.0.1');
  }
  if (!/^ndhm\.in#\d+\.\d+\.\d+$/.test(config.fhirPackage)) {
    throw new Error('ABDM_FHIR_PACKAGE must be explicitly pinned, for example ndhm.in#6.5.0');
  }
  if (config.isProduction && config.fhirPackage !== 'ndhm.in#6.5.0') {
    throw new Error('Production FHIR package differs from the approved ndhm.in#6.5.0 baseline');
  }
}

function assertPacketConfiguration() {
  const policies = new Set(['AUTO', 'REQUIRED_BEFORE_LINK', 'REQUIRED_BEFORE_TRANSFER', 'DUAL_APPROVAL']);
  if (!policies.has(config.packetDefaultReviewPolicy)) {
    throw new Error('ABDM_PACKET_DEFAULT_REVIEW_POLICY is invalid');
  }
  if (config.isProduction && config.packetStorePlaintext) {
    throw new Error('ABDM_PACKET_STORE_PLAINTEXT=true is forbidden in production');
  }
}

function assertTrustedInternalServices() {
  if (!config.isProduction) return;
  const required = [
    config.fhirValidatorUrl && new URL(config.fhirValidatorUrl).hostname,
    config.cryptoAdapterUrl && new URL(config.cryptoAdapterUrl).hostname,
    config.consentValidatorUrl && new URL(config.consentValidatorUrl).hostname
  ].filter(Boolean);
  const missing = required.filter((host) => !config.trustedInternalServiceHosts.includes(host));
  if (missing.length) {
    throw new Error(`ABDM_TRUSTED_INTERNAL_SERVICE_HOSTS is missing: ${missing.join(', ')}`);
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
  assertProfileConfiguration,
  assertPacketConfiguration,
  assertTrustedInternalServices,
  stripTrailingSlash,
  boolEnv,
  csvEnv,
  intCsvEnv
};
