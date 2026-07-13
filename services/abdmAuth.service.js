const abdmConfig = require('../config/abdm.config');
const { gatewayHeaders } = require('../utils/abdmRequest');

let cachedGatewayToken = null;
let gatewayTokenExpiresAt = 0;

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function jsonSafe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clearGatewayTokenCache() {
  cachedGatewayToken = null;
  gatewayTokenExpiresAt = 0;
}

async function getGatewayToken(options = {}) {
  if (!options.forceRefresh && cachedGatewayToken && Date.now() < gatewayTokenExpiresAt) {
    return cachedGatewayToken;
  }

  abdmConfig.assertMasterCredentials();

  const response = await fetchFn(abdmConfig.sessionUrl, {
    method: 'POST',
    headers: gatewayHeaders(null),
    body: JSON.stringify({
      clientId: abdmConfig.clientId,
      clientSecret: abdmConfig.clientSecret,
      grantType: 'client_credentials'
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.accessToken) {
    const error = new Error(
      data?.message || data?.error?.message || data?.error || `ABDM session failed: ${response.status} ${jsonSafe(data)}`
    );
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  cachedGatewayToken = data.accessToken;
  const expiresInSeconds = Number(data.expiresIn || 1200);
  gatewayTokenExpiresAt = Date.now() + Math.max(expiresInSeconds - 60, 60) * 1000;
  return cachedGatewayToken;
}

module.exports = { getGatewayToken, clearGatewayTokenCache };
