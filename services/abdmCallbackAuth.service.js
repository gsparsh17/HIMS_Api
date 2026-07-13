const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const abdmConfig = require('../config/abdm.config');
const { gatewayHeaders } = require('../utils/abdmRequest');

let cachedJwks = null;
let cachedUntil = 0;

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

async function getJwks() {
  if (cachedJwks && Date.now() < cachedUntil) return cachedJwks;
  const response = await fetchFn(`${abdmConfig.hiecmBaseUrl}/gateway/v3/certs`, {
    method: 'GET',
    headers: gatewayHeaders(null)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.keys)) {
    throw new Error(`Unable to load ABDM callback signing keys: ${response.status}`);
  }
  cachedJwks = data;
  cachedUntil = Date.now() + 6 * 60 * 60 * 1000;
  return cachedJwks;
}

function getBearer(headerValue) {
  const value = String(headerValue || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : value || null;
}

async function verifyCallbackToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error('ABDM callback JWT is missing kid');
  const jwks = await getJwks();
  const jwk = jwks.keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    cachedUntil = 0;
    const refreshed = await getJwks();
    const retryJwk = refreshed.keys.find((key) => key.kid === decoded.header.kid);
    if (!retryJwk) throw new Error('ABDM callback signing key not found');
    return verifyWithJwk(token, retryJwk);
  }
  return verifyWithJwk(token, jwk);
}

function verifyWithJwk(token, jwk) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256', 'RS384', 'RS512'],
    clockTolerance: 60
  });
}

module.exports = { verifyCallbackToken, getBearer, getJwks };
