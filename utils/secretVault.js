const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');

function getKey() {
  const source = abdmConfig.masterEncryptionKey;
  if (!source) {
    throw new Error('ABDM_MASTER_ENCRYPTION_KEY is required to encrypt connector secrets');
  }
  return crypto.createHash('sha256').update(String(source)).digest();
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptSecret(value) {
  if (!value?.ciphertext || !value?.iv || !value?.tag) {
    throw new Error('Encrypted connector secret is incomplete');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]);
  return clear.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
