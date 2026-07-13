require('dotenv').config({ path: `${__dirname}/../.env` });
const config = require('../config/abdm.config');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

check('APP_ROLE', ['HOSPITAL', 'ABDM_MASTER'].includes(config.appRole), config.appRole);
check('ABDM_ENV', ['sandbox', 'production'].includes(config.environment), config.environment);

if (config.isMaster) {
  check('Master MongoDB URI', Boolean(process.env.MONGO_URI), process.env.MONGO_URI ? 'configured' : 'missing');
  check('ABDM_CLIENT_ID', Boolean(config.clientId), config.clientId ? 'configured' : 'missing');
  check('ABDM_CLIENT_SECRET', Boolean(config.clientSecret), config.clientSecret ? 'configured' : 'missing');
  check('ABDM_BRIDGE_ID', Boolean(config.bridgeId), config.bridgeId || 'missing');
  check('ABDM_PUBLIC_BASE_URL HTTPS', /^https:\/\//i.test(config.publicBaseUrl || ''), config.publicBaseUrl || 'missing');
  check('ABDM_MASTER_ADMIN_KEY', Boolean(config.masterAdminKey), config.masterAdminKey ? 'configured' : 'missing');
  check('ABDM_MASTER_ENCRYPTION_KEY', Boolean(config.masterEncryptionKey), config.masterEncryptionKey ? 'configured' : 'missing');
  check('Callback authentication configured', config.verifyCallbackJwt || config.callbackAllowedIps.length > 0, config.verifyCallbackJwt ? 'JWT verification' : `${config.callbackAllowedIps.length} IP(s)`);
  if (String(process.env.ABDM_DATA_PUSH_MODE || 'disabled').toLowerCase() === 'external') {
    check('ABDM_CRYPTO_ADAPTER_URL', Boolean(process.env.ABDM_CRYPTO_ADAPTER_URL), process.env.ABDM_CRYPTO_ADAPTER_URL || 'missing');
    check('ABDM_DATA_PUSH_ALLOWED_HOSTS', config.dataPushAllowedHosts.length > 0, `${config.dataPushAllowedHosts.length} host(s)`);
    check('ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS', config.cryptoAdapterAllowedHosts.length > 0, `${config.cryptoAdapterAllowedHosts.length} host(s)`);
  }
}

if (config.isHospital) {
  check('Hospital MongoDB URI', Boolean(process.env.MONGO_URI), process.env.MONGO_URI ? 'configured' : 'missing');
  check('JWT_SECRET', Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET !== 'your_jwt_secret'), process.env.JWT_SECRET ? 'configured' : 'missing/weak placeholder');
  check('ABDM_MASTER_URL HTTPS', /^https:\/\//i.test(config.masterUrl || ''), config.masterUrl || 'missing');
  check('ABDM_HFR_FACILITY_ID', Boolean(config.hfrFacilityId), config.hfrFacilityId || 'missing');
  check('ABDM_HIP_ID', Boolean(config.hipId), config.hipId || 'missing');
  check('ABDM_CONNECTOR_KEY_ID', Boolean(config.connectorKeyId), config.connectorKeyId ? 'configured' : 'missing');
  check('ABDM_CONNECTOR_SECRET', Boolean(config.connectorSecret), config.connectorSecret ? 'configured' : 'missing');
  check('Permission checks enabled', String(process.env.DISABLE_PERMISSION_CHECKS || 'false').toLowerCase() !== 'true', process.env.DISABLE_PERMISSION_CHECKS || 'false');
}

for (const item of checks) {
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}: ${item.detail}`);
}
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`\n${failed.length} configuration check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll required ABDM deployment configuration checks passed.');
}
