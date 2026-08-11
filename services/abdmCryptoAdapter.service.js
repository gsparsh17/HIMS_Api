const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { requestInternalJson, checkInternalHealth } = require('./abdmInternalServiceClient');
const { masterRequest } = require('./abdmMasterClient.service');

function adapterHeaders() {
  const headers = {};
  if (process.env.ABDM_CRYPTO_ADAPTER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ABDM_CRYPTO_ADAPTER_TOKEN}`;
  }
  return headers;
}

function stripProvider(input = {}) {
  const { provider, ...body } = input || {};
  return body;
}

function selectedProvider(input) {
  const provider = String(input?.provider || abdmConfig.cryptoProvider || '').toLowerCase();
  if (!['master', 'local', 'mock'].includes(provider)) {
    const error = new Error(`Unsupported ABDM crypto provider: ${provider}`);
    error.code = 'ABDM_CRYPTO_PROVIDER_INVALID';
    error.statusCode = 500;
    throw error;
  }
  return provider;
}

async function masterCall(path, body) {
  abdmConfig.assertHospitalConnector();
  const route = {
    '/v1/receiver-key-material': '/internal/abdm/shared/crypto/receiver-key-material',
    '/v1/encrypt': '/internal/abdm/shared/crypto/encrypt',
    '/v1/decrypt': '/internal/abdm/shared/crypto/decrypt'
  }[path];
  if (!route) throw new Error(`Unsupported shared crypto route: ${path}`);
  return masterRequest(route, {
    method: 'POST',
    body,
    timeoutMs: abdmConfig.sharedServiceTimeoutMs
  });
}

async function localCall(path, body) {
  if (!abdmConfig.cryptoAdapterUrl) {
    const error = new Error('ABDM_CRYPTO_ADAPTER_URL is required when ABDM_CRYPTO_PROVIDER=local');
    error.code = 'ABDM_LOCAL_CRYPTO_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(
    path.replace(/^\//, ''),
    `${abdmConfig.cryptoAdapterUrl.replace(/\/+$/, '')}/`
  ).toString();
  return requestInternalJson({
    url,
    label: 'Hospital-local ABDM crypto adapter',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    body,
    timeoutMs: abdmConfig.cryptoAdapterTimeoutMs,
    maxResponseBytes: Number(process.env.ABDM_CRYPTO_ADAPTER_MAX_RESPONSE_BYTES || 25 * 1024 * 1024),
    headers: adapterHeaders()
  });
}

async function providerCall(provider, path, body) {
  if (provider === 'master') return masterCall(path, body);
  if (provider === 'local') return localCall(path, body);
  throw new Error(`Crypto provider ${provider} does not support external calls`);
}

function cryptoError(message, code, statusCode = 502, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function mockKeyMaterial() {
  const secret = crypto.randomBytes(32).toString('base64');
  return {
    provider: 'mock',
    publicKeyMaterial: {
      cryptoAlg: 'MOCK-ONLY',
      curve: 'MOCK-ONLY',
      dhPublicKey: {
        expiry: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        parameters: 'Development mock only',
        keyValue: Buffer.from(secret).toString('base64')
      },
      nonce: crypto.randomBytes(32).toString('base64')
    },
    privateMaterial: { secret }
  };
}

function assertMockAllowed() {
  if (process.env.NODE_ENV === 'production' || abdmConfig.isProduction) {
    throw new Error('Mock ABDM crypto is forbidden in production');
  }
}

function digestCandidates(value) {
  const buffer = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const digest = crypto.createHash('sha256').update(buffer).digest();
  return new Set([digest.toString('hex').toLowerCase(), digest.toString('base64'), digest.toString('base64url')]);
}

function assertDecryptionIntegrity({ encryptedEntries = [], decrypted }) {
  if (abdmConfig.requireCryptoIntegrity && decrypted.integrityVerified !== true) {
    const error = new Error('Crypto adapter did not explicitly confirm payload integrity');
    error.code = 'ABDM_CRYPTO_INTEGRITY_UNVERIFIED';
    throw error;
  }
  const records = decrypted.records || [];
  if (records.length !== encryptedEntries.length) {
    const error = new Error('Decrypted record count does not match encrypted entry count');
    error.code = 'ABDM_CRYPTO_ENTRY_COUNT_MISMATCH';
    throw error;
  }
  records.forEach((record, index) => {
    const checksum = encryptedEntries[index]?.checksum;
    if (!checksum) {
      const error = new Error(`Encrypted entry ${index} does not contain a checksum`);
      error.code = 'ABDM_CHECKSUM_MISSING';
      throw error;
    }
    const value = String(checksum).trim();
    if (!digestCandidates(record.content).has(value.toLowerCase()) && !digestCandidates(record.content).has(value)) {
      const error = new Error(`Checksum verification failed for encrypted entry ${index}`);
      error.code = 'ABDM_CHECKSUM_MISMATCH';
      throw error;
    }
  });
  return true;
}

async function generateReceiverKeyMaterial(input = {}) {
  const provider = selectedProvider(input);
  if (provider === 'mock') {
    assertMockAllowed();
    return mockKeyMaterial();
  }

  const result = await providerCall(provider, '/v1/receiver-key-material', stripProvider(input));
  if (!result.publicKeyMaterial || (!result.keyHandle && !result.privateMaterial)) {
    throw cryptoError(
      'Crypto adapter returned incomplete receiver key material',
      'ABDM_CRYPTO_KEY_MATERIAL_INVALID'
    );
  }
  if (abdmConfig.isProduction && !result.keyHandle) {
    throw cryptoError(
      'Production crypto adapter must return an opaque keyHandle instead of private key material',
      'ABDM_CRYPTO_KEY_HANDLE_REQUIRED'
    );
  }
  return { ...result, provider };
}

async function encryptHealthInformation(input = {}) {
  const provider = selectedProvider(input);
  if (provider === 'mock') {
    assertMockAllowed();
    return {
      provider,
      entries: (input.records || []).map((record) => ({
        content: Buffer.from(
          typeof record.content === 'string' ? record.content : JSON.stringify(record.content)
        ).toString('base64'),
        media: 'application/fhir+json',
        careContextReference: record.careContextReference,
        checksum: crypto
          .createHash('sha256')
          .update(typeof record.content === 'string' ? record.content : JSON.stringify(record.content))
          .digest('hex')
      })),
      keyMaterial: { cryptoAlg: 'MOCK-ONLY' }
    };
  }

  const result = await providerCall(provider, '/v1/encrypt', stripProvider(input));
  if (!Array.isArray(result.entries) || !result.entries.length || !result.keyMaterial) {
    throw cryptoError('Crypto adapter returned an invalid encrypted package', 'ABDM_CRYPTO_ENCRYPT_RESPONSE_INVALID');
  }
  for (const [index, entry] of result.entries.entries()) {
    if (!entry?.content || !entry?.checksum || !entry?.careContextReference) {
      throw cryptoError(
        `Crypto adapter encrypted entry ${index} is incomplete`,
        'ABDM_CRYPTO_ENCRYPT_ENTRY_INVALID'
      );
    }
  }
  return { ...result, provider };
}

async function decryptHealthInformation(input = {}) {
  // Receiver key handles/private material are stateful. Callers persist the provider
  // returned by generateReceiverKeyMaterial and pass it back here. This prevents a
  // config change from sending an old local keyHandle to Master (or vice versa).
  const provider = selectedProvider(input);
  if (provider === 'mock') {
    assertMockAllowed();
    return {
      provider,
      integrityVerified: true,
      records: (input.entries || []).map((entry) => ({
        content: Buffer.from(entry.content, 'base64').toString('utf8'),
        careContextReference: entry.careContextReference,
        hiType: entry.hiType,
        sourceHipId: entry.sourceHipId
      }))
    };
  }

  const result = await providerCall(provider, '/v1/decrypt', stripProvider(input));
  if (!Array.isArray(result.records)) {
    throw cryptoError('Crypto adapter returned no decrypted records', 'ABDM_CRYPTO_DECRYPT_RESPONSE_INVALID');
  }
  if (abdmConfig.requireCryptoIntegrity && result.integrityVerified !== true) {
    throw cryptoError(
      'Crypto adapter did not confirm authenticated decryption integrity',
      'ABDM_CRYPTO_INTEGRITY_UNVERIFIED',
      422
    );
  }
  return { ...result, provider };
}

async function masterCryptoHealth() {
  if (!abdmConfig.masterUrl) {
    return { configured: false, healthy: false, provider: 'master', location: 'MEDIQLIQ_MASTER' };
  }
  try {
    const response = await masterRequest('/internal/abdm/shared/health', {
      method: 'GET',
      timeoutMs: Math.min(abdmConfig.sharedServiceTimeoutMs || 30000, 5000)
    });
    const service = response?.services?.cryptoAdapter || {};
    return {
      ...service,
      configured: service.configured !== false,
      healthy: service.healthy === true,
      provider: 'master',
      location: 'MEDIQLIQ_MASTER',
      checkedAt: service.checkedAt || response?.checkedAt || new Date().toISOString()
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      provider: 'master',
      location: 'MEDIQLIQ_MASTER',
      checkedAt: new Date().toISOString(),
      errorCode: error.code || 'ABDM_MASTER_SHARED_CRYPTO_UNREACHABLE'
    };
  }
}

async function localCryptoHealth() {
  const healthUrl = abdmConfig.cryptoAdapterHealthUrl || (
    abdmConfig.cryptoAdapterUrl
      ? new URL('/health', `${abdmConfig.cryptoAdapterUrl}/`).toString()
      : ''
  );
  const health = await checkInternalHealth({
    url: healthUrl,
    label: 'Hospital-local ABDM crypto adapter health',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    timeoutMs: Math.min(abdmConfig.cryptoAdapterTimeoutMs, 5000)
  });
  return { ...health, provider: 'local', location: 'HOSPITAL_LOCAL' };
}

async function checkCryptoAdapterHealth(provider = abdmConfig.cryptoProvider) {
  if (provider === 'mock') {
    return {
      configured: true,
      healthy: !abdmConfig.isProduction,
      provider: 'mock',
      location: 'DEVELOPMENT_ONLY',
      productionCapable: false
    };
  }
  return provider === 'local' ? localCryptoHealth() : masterCryptoHealth();
}

module.exports = {
  generateReceiverKeyMaterial,
  encryptHealthInformation,
  decryptHealthInformation,
  assertDecryptionIntegrity,
  checkCryptoAdapterHealth,
  selectedProvider
};
