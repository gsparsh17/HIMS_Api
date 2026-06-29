const crypto = require('crypto');

let cachedGatewayToken = null;
let gatewayTokenExpiresAt = 0;
let cachedPublicKey = null;
let publicKeyExpiresAt = 0;

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

const ABDM_SESSION_URL = process.env.ABDM_SESSION_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions';
const ABDM_ABHA_BASE_URL = process.env.ABDM_ABHA_BASE_URL || 'https://abhasbx.abdm.gov.in/abha/api';
const ABDM_GATEWAY_BASE_URL = process.env.ABDM_GATEWAY_BASE_URL || 'https://dev.abdm.gov.in/gateway';

function getRequestId() {
  return crypto.randomUUID();
}

function toPem(base64PublicKey) {
  if (!base64PublicKey) throw new Error('ABDM public key is empty');
  if (base64PublicKey.includes('BEGIN PUBLIC KEY')) return base64PublicKey;
  const wrapped = base64PublicKey.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

function baseHeaders(accessToken, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'REQUEST-ID': getRequestId(),
    TIMESTAMP: new Date().toISOString(),
    Authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

function jsonSafe(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function getGatewayToken() {
  if (cachedGatewayToken && Date.now() < gatewayTokenExpiresAt) {
    return cachedGatewayToken;
  }

  if (!process.env.ABDM_CLIENT_ID || !process.env.ABDM_CLIENT_SECRET) {
    throw new Error('ABDM_CLIENT_ID and ABDM_CLIENT_SECRET are required in .env');
  }

  const response = await fetchFn(ABDM_SESSION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.ABDM_CLIENT_ID,
      clientSecret: process.env.ABDM_CLIENT_SECRET
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `ABDM session failed: ${response.status} ${jsonSafe(data)}`);
  }

  cachedGatewayToken = data.accessToken;
  const expiresInSeconds = Number(data.expiresIn || 1200);
  gatewayTokenExpiresAt = Date.now() + Math.max(expiresInSeconds - 60, 60) * 1000;
  return cachedGatewayToken;
}

async function getPublicKeyPem() {
  if (cachedPublicKey && Date.now() < publicKeyExpiresAt) {
    return cachedPublicKey;
  }

  const gatewayToken = await getGatewayToken();
  const response = await fetchFn(`${ABDM_ABHA_BASE_URL}/v3/profile/public/certificate`, {
    method: 'GET',
    headers: baseHeaders(gatewayToken)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `ABDM certificate failed: ${response.status} ${jsonSafe(data)}`);
  }

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

async function abdmPost(path, body, extraHeaders = {}) {
  const gatewayToken = await getGatewayToken();
  const response = await fetchFn(`${ABDM_ABHA_BASE_URL}${path}`, {
    method: 'POST',
    headers: baseHeaders(gatewayToken, extraHeaders),
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error?.message || data?.error || `ABDM API failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function abdmGet(path, extraHeaders = {}, responseType = 'json') {
  const gatewayToken = await getGatewayToken();
  const response = await fetchFn(`${ABDM_ABHA_BASE_URL}${path}`, {
    method: 'GET',
    headers: baseHeaders(gatewayToken, extraHeaders)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data?.message || data?.error?.message || data?.error || `ABDM API failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  if (responseType === 'buffer') {
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || 'application/octet-stream'
    };
  }

  return response.json().catch(() => ({}));
}

async function updateBridgeUrl(bridgeUrl) {
  const gatewayToken = await getGatewayToken();
  const ABDM_HIECM_BASE_URL = process.env.ABDM_HIECM_BASE_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway';
  
  const response = await fetchFn(`${ABDM_HIECM_BASE_URL}/v3/bridge/url`, {
    method: 'PATCH',
    headers: {
      'accept': '*/*',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`,
      'REQUEST-ID': crypto.randomUUID(),
      'TIMESTAMP': new Date().toISOString(),
      'X-CM-ID': process.env.ABDM_CM_ID || 'sbx'
    },
    body: JSON.stringify({ 
      bridgeId: process.env.ABDM_BRIDGE_ID || 'SBXID_043402',
      url: bridgeUrl 
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Bridge URL update failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function addHipService(publicBaseUrl) {
  const gatewayToken = await getGatewayToken();
  const ABDM_GATEWAY_BASE_URL = process.env.ABDM_GATEWAY_BASE_URL || 'https://dev.abdm.gov.in/gateway';
  
  const body = [
    {
      id: process.env.ABDM_HIP_SERVICE_ID || 'CITY_HOSPITAL_HIP',
      name: process.env.ABDM_HIP_SERVICE_NAME || 'City Hospital HIP',
      type: 'HIP',
      active: true,
      alias: [process.env.ABDM_HIP_ALIAS || 'city-hospital'],
      endpoints: [
        {
          address: publicBaseUrl,
          connectionType: 'https',
          use: 'registration'
        }
      ]
    }
  ];

  const response = await fetchFn(`${ABDM_GATEWAY_BASE_URL}/v1/bridges/addUpdateServices`, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Add HIP service failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function getBridgeServices() {
  const gatewayToken = await getGatewayToken();
  const ABDM_GATEWAY_BASE_URL = process.env.ABDM_GATEWAY_BASE_URL || 'https://dev.abdm.gov.in/gateway';
  
  const response = await fetchFn(`${ABDM_GATEWAY_BASE_URL}/v1/bridges/getServices`, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Get services failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

module.exports = {
  getGatewayToken,
  encryptForAbdm,
  abdmPost,
  abdmGet,
  updateBridgeUrl,
  addHipService,
  getBridgeServices
};
