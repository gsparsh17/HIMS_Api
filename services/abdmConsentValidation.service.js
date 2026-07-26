const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

async function validateConsentArtefact(artefact) {
  if (!abdmConfig.consentValidatorUrl) {
    return {
      valid: false,
      skipped: true,
      reason: 'ABDM_CONSENT_VALIDATOR_URL is not configured'
    };
  }

  const url = await assertSafeOutboundUrl(abdmConfig.consentValidatorUrl, {
    label: 'ABDM consent validator URL',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    requireHttps: process.env.NODE_ENV === 'production',
    allowPrivate: process.env.NODE_ENV !== 'production'
  });
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.ABDM_CONSENT_VALIDATOR_TOKEN
        ? {
            Authorization: `Bearer ${process.env.ABDM_CONSENT_VALIDATOR_TOKEN}`
          }
        : {})
    },
    body: JSON.stringify({
      artefact,
      environment: abdmConfig.environment,
      hipId: abdmConfig.hipId,
      hiuId: abdmConfig.hiuId
    }),
    signal: AbortSignal.timeout(
      Number(process.env.ABDM_CONSENT_VALIDATOR_TIMEOUT_MS || 15000)
    ),
    redirect: 'error'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.message ||
        `Consent validator failed with HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.details = result;
    throw error;
  }
  return {
    ...result,
    valid: result.valid === true || result.signatureVerified === true
  };
}

module.exports = { validateConsentArtefact };
