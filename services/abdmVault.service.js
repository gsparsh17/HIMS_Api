const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');

function keyBuffer() {
  abdmConfig.assertEncryptionKey();
  const raw = String(abdmConfig.hospitalEncryptionKey).trim();

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_error) {
    // Fall through to deterministic derivation for legacy development keys.
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'ABDM_HOSPITAL_ENCRYPTION_KEY must be a 32-byte base64 value or 64-character hex value in production'
    );
  }

  return crypto.createHash('sha256').update(raw).digest();
}

function encryptBuffer(value, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad)));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: 'v1'
  };
}

function decryptBuffer(blob, aad = '') {
  if (!blob?.ciphertext || !blob?.iv || !blob?.tag) {
    throw new Error('Encrypted ABDM value is incomplete');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyBuffer(),
    Buffer.from(blob.iv, 'base64')
  );
  if (aad) decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final()
  ]);
}

function encryptJson(value, aad = '') {
  return encryptBuffer(Buffer.from(JSON.stringify(value)), aad);
}

function decryptJson(blob, aad = '') {
  return JSON.parse(decryptBuffer(blob, aad).toString('utf8'));
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  encryptJson,
  decryptJson
};
