const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { requestInternalJson, checkInternalHealth } = require('./abdmInternalServiceClient');

function adapterHeaders() {
  const headers = {};
  if (process.env.ABDM_CRYPTO_ADAPTER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ABDM_CRYPTO_ADAPTER_TOKEN}`;
  }
  return headers;
}

async function externalCall(path, body) {
  abdmConfig.assertCryptoConfiguration();
  const url = new URL(
    path.replace(/^\//, ''),
    `${abdmConfig.cryptoAdapterUrl.replace(/\/+$/, '')}/`
  ).toString();
  return requestInternalJson({
    url,
    label: 'ABDM crypto adapter',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    body,
    timeoutMs: abdmConfig.cryptoAdapterTimeoutMs,
    maxResponseBytes: Number(process.env.ABDM_CRYPTO_ADAPTER_MAX_RESPONSE_BYTES || 25 * 1024 * 1024),
    headers: adapterHeaders()
  });
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
  if (process.env.NODE_ENV === 'production') {
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

async function generateReceiverKeyMaterial(input) {
  if (abdmConfig.cryptoMode === 'external') {
    const result = await externalCall('/v1/receiver-key-material', input);
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
    return result;
  }
  if (abdmConfig.cryptoMode === 'mock') {
    assertMockAllowed();
    return mockKeyMaterial();
  }
  throw new Error(`Unsupported ABDM_CRYPTO_MODE=${abdmConfig.cryptoMode}`);
}

async function encryptHealthInformation(input) {
  if (abdmConfig.cryptoMode === 'external') {
    const result = await externalCall('/v1/encrypt', input);
    if (!Array.isArray(result.entries) || !result.entries.length || !result.keyMaterial) {
      throw cryptoError(
        'Crypto adapter returned an invalid encrypted package',
        'ABDM_CRYPTO_ENCRYPT_RESPONSE_INVALID'
      );
    }
    for (const [index, entry] of result.entries.entries()) {
      if (!entry?.content || !entry?.checksum || !entry?.careContextReference) {
        throw cryptoError(
          `Crypto adapter encrypted entry ${index} is incomplete`,
          'ABDM_CRYPTO_ENCRYPT_ENTRY_INVALID'
        );
      }
    }
    return result;
  }
  if (abdmConfig.cryptoMode === 'mock') {
    assertMockAllowed();
    return {
      entries: input.records.map((record) => ({
        content: Buffer.from(
          typeof record.content === 'string'
            ? record.content
            : JSON.stringify(record.content)
        ).toString('base64'),
        media: 'application/fhir+json',
        careContextReference: record.careContextReference,
        checksum: crypto
          .createHash('sha256')
          .update(
            typeof record.content === 'string'
              ? record.content
              : JSON.stringify(record.content)
          )
          .digest('hex')
      })),
      keyMaterial: { cryptoAlg: 'MOCK-ONLY' }
    };
  }
  throw new Error(`Unsupported ABDM_CRYPTO_MODE=${abdmConfig.cryptoMode}`);
}

async function decryptHealthInformation(input) {
  if (abdmConfig.cryptoMode === 'external') {
    const result = await externalCall('/v1/decrypt', input);
    if (!Array.isArray(result.records)) {
      throw cryptoError(
        'Crypto adapter returned no decrypted records',
        'ABDM_CRYPTO_DECRYPT_RESPONSE_INVALID'
      );
    }
    if (abdmConfig.requireCryptoIntegrity && result.integrityVerified !== true) {
      throw cryptoError(
        'Crypto adapter did not confirm authenticated decryption integrity',
        'ABDM_CRYPTO_INTEGRITY_UNVERIFIED',
        422
      );
    }
    return result;
  }
  if (abdmConfig.cryptoMode === 'mock') {
    assertMockAllowed();
    return {
      integrityVerified: true,
      records: (input.entries || []).map((entry) => ({
        content: Buffer.from(entry.content, 'base64').toString('utf8'),
        careContextReference: entry.careContextReference,
        hiType: entry.hiType,
        sourceHipId: entry.sourceHipId
      }))
    };
  }
  throw new Error(`Unsupported ABDM_CRYPTO_MODE=${abdmConfig.cryptoMode}`);
}

async function checkCryptoAdapterHealth() {
  const healthUrl = abdmConfig.cryptoAdapterHealthUrl || (
    abdmConfig.cryptoAdapterUrl
      ? new URL('/health', `${abdmConfig.cryptoAdapterUrl}/`).toString()
      : ''
  );
  return checkInternalHealth({
    url: healthUrl,
    label: 'ABDM crypto adapter health',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    timeoutMs: Math.min(abdmConfig.cryptoAdapterTimeoutMs, 5000)
  });
}

module.exports = {
  generateReceiverKeyMaterial,
  encryptHealthInformation,
  decryptHealthInformation,
  assertDecryptionIntegrity,
  checkCryptoAdapterHealth
};
