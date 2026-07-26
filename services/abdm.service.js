const crypto = require('crypto');
const { masterRequest } = require('./abdmMasterClient.service');

let cachedPublicKey;
let publicKeyExpiresAt = 0;

function toPem(base64PublicKey) {
  if (!base64PublicKey) throw new Error('ABDM public key is empty');
  if (base64PublicKey.includes('BEGIN PUBLIC KEY')) return base64PublicKey;
  const wrapped = base64PublicKey.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

async function proxyAbha({ method, path, body, extraHeaders = {}, responseType = 'json' }) {
  const response = await masterRequest('/internal/abdm/m1/proxy', {
    method: 'POST',
    body: {
      method,
      path,
      body,
      headers: extraHeaders,
      responseType
    }
  });
  if (responseType === 'buffer') {
    return {
      buffer: Buffer.from(response.dataBase64 || '', 'base64'),
      contentType: response.contentType || 'application/octet-stream'
    };
  }
  return response.data;
}

async function abdmPost(path, body, extraHeaders = {}) {
  return proxyAbha({ method: 'POST', path, body, extraHeaders });
}

async function abdmGet(path, extraHeaders = {}, responseType = 'json') {
  return proxyAbha({ method: 'GET', path, extraHeaders, responseType });
}

async function getPublicKeyPem() {
  if (cachedPublicKey && Date.now() < publicKeyExpiresAt) return cachedPublicKey;
  const data = await abdmGet('/v3/profile/public/certificate');
  cachedPublicKey = toPem(data.publicKey);
  publicKeyExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return cachedPublicKey;
}

async function encryptForAbdm(value) {
  const publicKey = await getPublicKeyPem();
  return crypto
    .publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1'
      },
      Buffer.from(String(value), 'utf8')
    )
    .toString('base64');
}

module.exports = {
  encryptForAbdm,
  abdmPost,
  abdmGet
};
