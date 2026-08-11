require('dotenv').config({ path: `${__dirname}/../.env` });
const config = require('../config/abdm.config');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function strongSecret(value, minimum = 32) {
  return Boolean(value && String(value).length >= minimum && !/replace|your_|secret/i.test(value));
}

check('APP_ROLE is hospital-only', process.env.APP_ROLE === 'HOSPITAL' || !process.env.APP_ROLE, process.env.APP_ROLE || 'HOSPITAL');
check('ABDM_ENV', ['sandbox', 'production'].includes(config.environment), config.environment);
check('MONGO_URI', Boolean(process.env.MONGO_URI), process.env.MONGO_URI ? 'configured' : 'missing');
check('JWT_SECRET strength', strongSecret(process.env.JWT_SECRET, 32), process.env.JWT_SECRET ? 'configured' : 'missing');
check('ABDM_MASTER_URL', Boolean(config.masterUrl), config.masterUrl || 'missing');
check(
  'ABDM_MASTER_URL transport',
  config.environment !== 'production' || /^https:\/\//i.test(config.masterUrl),
  config.masterUrl || 'missing'
);
check('ABDM_HFR_FACILITY_ID', Boolean(config.hfrFacilityId), config.hfrFacilityId || 'missing');
check('ABDM_HIP_ID', Boolean(config.hipId), config.hipId || 'missing');
check('ABDM_HIU_ID', !config.featureM3 || Boolean(config.hiuId), config.hiuId || 'missing');
check('ABDM_CONNECTOR_KEY_ID', Boolean(config.connectorKeyId), config.connectorKeyId ? 'configured' : 'missing');
check('ABDM_CONNECTOR_SECRET strength', strongSecret(config.connectorSecret, 32), config.connectorSecret ? 'configured' : 'missing');
check('ABDM_HOSPITAL_ENCRYPTION_KEY', Boolean(config.hospitalEncryptionKey), config.hospitalEncryptionKey ? 'configured' : 'missing');
check('Permission checks enabled', String(process.env.DISABLE_PERMISSION_CHECKS || 'false').toLowerCase() !== 'true', process.env.DISABLE_PERMISSION_CHECKS || 'false');
check('FHIR provider', ['master', 'local'].includes(config.fhirProvider), config.fhirProvider);
check(
  'FHIR primary provider configured',
  config.fhirProvider === 'master' ? Boolean(config.masterUrl) : Boolean(config.fhirValidatorUrl),
  config.fhirProvider === 'master' ? (config.masterUrl || 'missing Master URL') : (config.fhirValidatorUrl || 'missing local FHIR URL')
);
check(
  'FHIR fallback provider configured',
  config.fhirFallbackProvider === 'none' ||
    (config.fhirFallbackProvider === 'master' ? Boolean(config.masterUrl) : Boolean(config.fhirValidatorUrl)),
  config.fhirFallbackProvider
);
check('Crypto provider', ['master', 'local', 'mock'].includes(config.cryptoProvider), config.cryptoProvider);
check(
  'Production crypto provider',
  config.environment !== 'production' || config.cryptoProvider !== 'mock',
  config.cryptoProvider
);
check(
  'Crypto provider configured',
  config.cryptoProvider === 'master'
    ? Boolean(config.masterUrl)
    : (config.cryptoProvider === 'local' ? Boolean(config.cryptoAdapterUrl) : config.environment !== 'production'),
  config.cryptoProvider === 'local' ? (config.cryptoAdapterUrl || 'missing local crypto URL') : config.cryptoProvider
);
check('Consent provider', ['master', 'local'].includes(config.consentProvider), config.consentProvider);
check(
  'Consent provider configured',
  config.consentProvider === 'master' ? Boolean(config.masterUrl) : Boolean(config.consentValidatorUrl),
  config.consentProvider === 'master' ? (config.masterUrl || 'missing Master URL') : (config.consentValidatorUrl || 'missing local consent URL')
);
check(
  'Production data-push allow-list',
  config.environment !== 'production' || config.dataPushAllowedHosts.length > 0,
  `${config.dataPushAllowedHosts.length} host(s)`
);
check(
  'Production external FHIR validation',
  config.environment !== 'production' || !config.requireExternalFhirValidation ||
    (config.fhirProvider === 'master' ? Boolean(config.masterUrl) : Boolean(config.fhirValidatorUrl)),
  config.fhirProvider
);
check(
  'Production consent validation',
  config.environment !== 'production' || !config.requireConsentValidation ||
    (config.consentProvider === 'master' ? Boolean(config.masterUrl) : Boolean(config.consentValidatorUrl)),
  config.consentProvider
);
check(
  'Local consent validator service token',
  config.environment !== 'production' || config.consentProvider !== 'local' || !config.requireConsentValidation ||
    strongSecret(process.env.ABDM_CONSENT_VALIDATOR_TOKEN || config.internalServiceAuthToken, 32),
  config.consentProvider === 'local'
    ? (process.env.ABDM_CONSENT_VALIDATOR_TOKEN || config.internalServiceAuthToken ? 'configured' : 'missing')
    : 'not required for Master provider'
);
check(
  'Local consent validator endpoint version',
  config.consentProvider !== 'local' || !config.consentValidatorUrl || /\/v1\/validate\/?$/i.test(config.consentValidatorUrl),
  config.consentValidatorUrl || 'not local'
);
check(
  'Local FHIR validator allow-list',
  config.environment !== 'production' || !config.localProviderRequired('fhir') || config.fhirValidatorAllowedHosts.length > 0 || config.trustedInternalServiceHosts.length > 0,
  `${config.fhirValidatorAllowedHosts.length} service-specific, ${config.trustedInternalServiceHosts.length} trusted host(s)`
);
check(
  'Local consent validator allow-list',
  config.environment !== 'production' || config.consentProvider !== 'local' || config.consentValidatorAllowedHosts.length > 0 || config.trustedInternalServiceHosts.length > 0,
  `${config.consentValidatorAllowedHosts.length} service-specific, ${config.trustedInternalServiceHosts.length} trusted host(s)`
);
check(
  'Local crypto adapter allow-list',
  config.environment !== 'production' || config.cryptoProvider !== 'local' || config.cryptoAdapterAllowedHosts.length > 0 || config.trustedInternalServiceHosts.length > 0,
  `${config.cryptoAdapterAllowedHosts.length} service-specific, ${config.trustedInternalServiceHosts.length} trusted host(s)`
);
check(
  'Production test OTP disabled',
  config.environment !== 'production' || String(process.env.ABDM_LINK_OTP_TEST_MODE || 'false').toLowerCase() !== 'true',
  process.env.ABDM_LINK_OTP_TEST_MODE || 'false'
);

for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}: ${item.detail}`);
}
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`\n${failed.length} configuration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nHospital ABDM configuration checks passed.');
}
