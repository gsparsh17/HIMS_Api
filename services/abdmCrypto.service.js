const crypto = require('crypto');

function checksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Reference X25519 helper for ABDM data-flow integration.
 * The exact serialization/envelope must be validated against the current ABDM
 * sandbox conformance examples before production certification.
 */
function generateX25519KeyMaterial(expiryMs = 10 * 60 * 1000) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const nonce = crypto.randomBytes(32);
  return {
    privateKey,
    nonce,
    public: {
      cryptoAlg: 'ECDH',
      curve: 'Curve25519',
      dhPublicKey: {
        expiry: new Date(Date.now() + expiryMs).toISOString(),
        parameters: 'Curve25519/32byte random key',
        keyValue: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      },
      nonce: nonce.toString('base64')
    }
  };
}

function deriveSharedKey(privateKey, peerPublicKeyBase64, localNonce, peerNonceBase64) {
  const peerPublicKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyBase64, 'base64'),
    type: 'spki',
    format: 'der'
  });
  const shared = crypto.diffieHellman({ privateKey, publicKey: peerPublicKey });
  const salt = Buffer.concat([
    Buffer.isBuffer(localNonce) ? localNonce : Buffer.from(localNonce, 'base64'),
    Buffer.from(peerNonceBase64 || '', 'base64')
  ]);
  return crypto.hkdfSync('sha256', shared, salt, Buffer.from('ABDM-HI-DATA'), 32);
}

function encryptContent(content, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

module.exports = {
  checksum,
  generateX25519KeyMaterial,
  deriveSharedKey,
  encryptContent
};
