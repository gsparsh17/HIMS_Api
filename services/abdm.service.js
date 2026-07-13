const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { abhaRequest, updateBridgeUrl: directUpdateBridgeUrl, getBridgeServices, getBridgeByServiceId } = require('./abdmHttp.service');
const { getGatewayToken: directGetGatewayToken } = require('./abdmAuth.service');
const { masterRequest } = require('./abdmMasterClient.service');

let cachedPublicKey = null;
let publicKeyExpiresAt = 0;

function toPem(base64PublicKey) {
  if (!base64PublicKey) throw new Error('ABDM public key is empty');
  if (base64PublicKey.includes('BEGIN PUBLIC KEY')) return base64PublicKey;
  const wrapped = base64PublicKey.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

function usingMasterProxy() {
  return abdmConfig.isHospital && !abdmConfig.isMaster && Boolean(abdmConfig.masterUrl);
}

async function getGatewayToken() {
  if (usingMasterProxy()) {
    throw new Error('Gateway tokens are intentionally kept on the ABDM master and are not exposed to hospital servers');
  }
  return directGetGatewayToken();
}

async function proxyAbha({ method, path, body, extraHeaders = {}, responseType = 'json' }) {
  const data = await masterRequest('/internal/abdm/proxy/abha', {
    method: 'POST',
    body: { method, path, body, headers: extraHeaders, responseType }
  });
  if (responseType === 'buffer') {
    return {
      buffer: Buffer.from(data.dataBase64 || '', 'base64'),
      contentType: data.contentType || 'application/octet-stream'
    };
  }
  return data.data;
}

async function abdmPost(path, body, extraHeaders = {}) {
  if (usingMasterProxy()) {
    return proxyAbha({ method: 'POST', path, body, extraHeaders });
  }
  return abhaRequest(path, { method: 'POST', body, headers: extraHeaders });
}

async function abdmGet(path, extraHeaders = {}, responseType = 'json') {
  if (usingMasterProxy()) {
    return proxyAbha({ method: 'GET', path, extraHeaders, responseType });
  }
  return abhaRequest(path, { method: 'GET', headers: extraHeaders, responseType });
}

async function getPublicKeyPem() {
  if (cachedPublicKey && Date.now() < publicKeyExpiresAt) return cachedPublicKey;
  const data = await abdmGet('/v3/profile/public/certificate');
  cachedPublicKey = toPem(data.publicKey);
  publicKeyExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return cachedPublicKey;
}

async function encryptForAbdm(plainValue) {
  const publicKey = await getPublicKeyPem();
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1'
    },
    Buffer.from(String(plainValue), 'utf8')
  ).toString('base64');
}

async function updateBridgeUrl(bridgeUrl) {
  if (usingMasterProxy()) {
    throw new Error('Bridge URL management is only available on the ABDM master deployment');
  }
  return directUpdateBridgeUrl(bridgeUrl);
}

async function addHipService() {
  const error = new Error(
    'Legacy /gateway/v1/bridges/addUpdateServices is disabled. Register each facility in NHPR/HFR and complete Software Linkage with the MediQliq Bridge ID.'
  );
  error.code = 'ABDM_LEGACY_FACILITY_REGISTRATION_DISABLED';
  throw error;
}

module.exports = {
  getGatewayToken,
  encryptForAbdm,
  abdmPost,
  abdmGet,
  updateBridgeUrl,
  addHipService,
  getBridgeServices,
  getBridgeByServiceId
};
