const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function adapterHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ABDM_CRYPTO_ADAPTER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.ABDM_CRYPTO_ADAPTER_TOKEN}`;
  }
  return headers;
}

async function externalCall(path, body) {
  abdmConfig.assertCryptoConfiguration();
  const base = await assertSafeOutboundUrl(abdmConfig.cryptoAdapterUrl, {
    label: 'ABDM crypto adapter URL',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    requireHttps: process.env.NODE_ENV === 'production',
    allowPrivate:
      process.env.NODE_ENV !== 'production' &&
      abdmConfig.allowPrivateAdapterUrls
  });
  const url = new URL(path.replace(/^\//, ''), `${base.replace(/\/+$/, '')}/`).toString();
  const response = await fetchFn(url, {
    method: 'POST',
    headers: adapterHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(
      Number(process.env.ABDM_CRYPTO_ADAPTER_TIMEOUT_MS || 30000)
    ),
    redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.message || `ABDM crypto adapter failed with HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
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
    if (!result.publicKeyMaterial || !result.privateMaterial) {
      throw new Error('Crypto adapter returned incomplete receiver key material');
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
    if (!Array.isArray(result.entries) || !result.keyMaterial) {
      throw new Error('Crypto adapter returned an invalid encrypted package');
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
      throw new Error('Crypto adapter returned no decrypted records');
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

module.exports = {
  generateReceiverKeyMaterial,
  encryptHealthInformation,
  decryptHealthInformation,
  assertDecryptionIntegrity
};
