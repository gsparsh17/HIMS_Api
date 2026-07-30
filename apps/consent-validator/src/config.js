function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function csvEnv(name, fallback = '') {
  return String(process.env[name] || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function intEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function parseJsonEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`);
  }
}

const environment = String(
  process.env.CONSENT_VALIDATOR_ENV || process.env.ABDM_ENV || 'sandbox'
).toLowerCase();
const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const isProduction = environment === 'production' || nodeEnv === 'production';

const config = {
  serviceName: 'mediqliq-abdm-consent-validator',
  version: process.env.CONSENT_VALIDATOR_VERSION || '1.0.0',
  host: process.env.HOST || '0.0.0.0',
  port: intEnv('PORT', 8180),
  environment,
  isProduction,
  mongoUri:
    process.env.CONSENT_VALIDATOR_MONGO_URI || process.env.MONGO_URI || '',
  serviceToken:
    process.env.CONSENT_VALIDATOR_SERVICE_TOKEN ||
    process.env.MEDIQLIQ_SERVICE_TOKEN ||
    '',
  serviceTokenHeader:
    process.env.CONSENT_VALIDATOR_SERVICE_TOKEN_HEADER ||
    'x-mediqliq-service-token',
  identifierPepper: process.env.CONSENT_VALIDATOR_IDENTIFIER_PEPPER || '',
  allowedAlgorithms: csvEnv(
    'CONSENT_VALIDATOR_ALLOWED_ALGORITHMS',
    'RS256,RS512,ES256'
  ),
  expectedIssuers: csvEnv('CONSENT_VALIDATOR_EXPECTED_ISSUERS'),
  expectedAudiences: csvEnv('CONSENT_VALIDATOR_EXPECTED_AUDIENCES'),
  jwksUrl: process.env.CONSENT_VALIDATOR_JWKS_URL || '',
  jwksAllowedHosts: csvEnv('CONSENT_VALIDATOR_JWKS_ALLOWED_HOSTS'),
  pinnedJwks: parseJsonEnv('CONSENT_VALIDATOR_PINNED_JWKS_JSON'),
  clockSkewSeconds: Math.max(
    0,
    intEnv('CONSENT_VALIDATOR_CLOCK_SKEW_SECONDS', 120)
  ),
  jwksCacheSeconds: Math.max(
    30,
    intEnv('CONSENT_VALIDATOR_JWKS_CACHE_SECONDS', 3600)
  ),
  requestBodyLimit: process.env.CONSENT_VALIDATOR_BODY_LIMIT || '2mb',
  rateLimitWindowMs: Math.max(1000, intEnv('CONSENT_VALIDATOR_RATE_LIMIT_WINDOW_MS', 60000)),
  rateLimitMax: Math.max(1, intEnv('CONSENT_VALIDATOR_RATE_LIMIT_MAX', 300)),
  decisionTtlSeconds: Math.max(
    30,
    intEnv('CONSENT_VALIDATOR_DECISION_TTL_SECONDS', 300)
  ),
  reservationTtlSeconds: Math.max(
    60,
    intEnv('CONSENT_VALIDATOR_RESERVATION_TTL_SECONDS', 900)
  ),
  requireMongoTransactions: boolEnv(
    'CONSENT_VALIDATOR_REQUIRE_MONGO_TRANSACTIONS',
    isProduction
  ),
  consumeFrequencyFor: new Set(
    csvEnv(
      'CONSENT_VALIDATOR_FREQUENCY_OPERATIONS',
      'HIP_DISCLOSURE,HIU_DATA_REQUEST'
    ).map((item) => item.toUpperCase())
  ),
  repeatsMode: String(
    process.env.CONSENT_VALIDATOR_FREQUENCY_REPEATS_MODE || 'ADDITIONAL'
  ).toUpperCase(),
  allowUnsignedSandboxArtefacts: boolEnv(
    'CONSENT_VALIDATOR_ALLOW_UNSIGNED_SANDBOX_ARTEFACTS',
    false
  ),
  maxRetentionDays: Math.max(
    1,
    intEnv('CONSENT_VALIDATOR_MAX_RETENTION_DAYS', 3650)
  ),
  trustFetchTimeoutMs: Math.max(
    1000,
    intEnv('CONSENT_VALIDATOR_TRUST_FETCH_TIMEOUT_MS', 5000)
  )
};

function assertStartupConfig() {
  const errors = [];
  if (!config.mongoUri) errors.push('CONSENT_VALIDATOR_MONGO_URI is required');
  if (!config.serviceToken || config.serviceToken.length < 32) {
    errors.push('CONSENT_VALIDATOR_SERVICE_TOKEN must be at least 32 characters');
  }
  if (!config.identifierPepper || config.identifierPepper.length < 16) {
    errors.push('CONSENT_VALIDATOR_IDENTIFIER_PEPPER must be at least 16 characters');
  }
  if (!config.allowedAlgorithms.length) {
    errors.push('CONSENT_VALIDATOR_ALLOWED_ALGORITHMS cannot be empty');
  }
  if (!config.jwksUrl && !config.pinnedJwks && !config.allowUnsignedSandboxArtefacts) {
    errors.push(
      'Configure CONSENT_VALIDATOR_JWKS_URL or CONSENT_VALIDATOR_PINNED_JWKS_JSON'
    );
  }
  if (config.pinnedJwks && (!Array.isArray(config.pinnedJwks.keys) || !config.pinnedJwks.keys.length)) {
    errors.push('CONSENT_VALIDATOR_PINNED_JWKS_JSON must contain at least one signing key');
  }
  if (config.jwksUrl) {
    try {
      const trustUrl = new URL(config.jwksUrl);
      if (trustUrl.username || trustUrl.password) {
        errors.push('CONSENT_VALIDATOR_JWKS_URL must not contain credentials');
      }
      if (config.isProduction && trustUrl.protocol !== 'https:') {
        errors.push('CONSENT_VALIDATOR_JWKS_URL must use HTTPS in production');
      }
      if (config.isProduction && !config.jwksAllowedHosts.map((item) => item.toLowerCase()).includes(trustUrl.hostname.toLowerCase())) {
        errors.push('CONSENT_VALIDATOR_JWKS_URL hostname must be present in CONSENT_VALIDATOR_JWKS_ALLOWED_HOSTS');
      }
    } catch (_error) {
      errors.push('CONSENT_VALIDATOR_JWKS_URL must be a valid URL');
    }
  }
  if (config.isProduction) {
    if (config.allowUnsignedSandboxArtefacts) {
      errors.push(
        'CONSENT_VALIDATOR_ALLOW_UNSIGNED_SANDBOX_ARTEFACTS is forbidden in production'
      );
    }
    if (!config.expectedIssuers.length) {
      errors.push('CONSENT_VALIDATOR_EXPECTED_ISSUERS is required in production');
    }
    if (!config.expectedAudiences.length) {
      errors.push('CONSENT_VALIDATOR_EXPECTED_AUDIENCES is required in production');
    }
  }
  if (errors.length) {
    const error = new Error(`Consent validator configuration failed: ${errors.join('; ')}`);
    error.code = 'CONSENT_VALIDATOR_CONFIG_INVALID';
    throw error;
  }
}

module.exports = { config, boolEnv, csvEnv, assertStartupConfig };
