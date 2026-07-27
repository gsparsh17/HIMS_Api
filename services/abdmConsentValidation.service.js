const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function structuralConsentValidation(artefact = {}) {
  const value = artefact.consentDetail || artefact.consent || artefact.consentArtefact || artefact.notification || artefact;
  const permission = value.permission || artefact.permission || {};
  const errors = [];
  const consentId = value.id || artefact.consentId || artefact.notification?.consentId;
  if (!consentId) errors.push('Consent identifier is missing');
  if (!permission.dateRange?.from || !permission.dateRange?.to) errors.push('Consent date range is missing');
  if (!permission.dataEraseAt && !permission.permissionExpiry && !value.expiresAt) errors.push('Consent expiry/data erase time is missing');
  const hiTypes = permission.hiTypes || value.hiTypes || artefact.hiTypes;
  if (!Array.isArray(hiTypes) || !hiTypes.length) errors.push('Consent HI types are missing');
  const patient = value.patient || artefact.patient;
  if (!patient?.id && !patient?.abhaAddress && !artefact.abhaAddress) errors.push('Consent patient identity is missing');
  return { valid: errors.length === 0, errors };
}

async function validateConsentArtefact(artefact) {
  const structural = structuralConsentValidation(artefact);
  if (!structural.valid) {
    const error = new Error('Consent artefact is structurally invalid');
    error.statusCode = 422;
    error.code = 'ABDM_CONSENT_INVALID';
    error.details = structural;
    throw error;
  }

  if (!abdmConfig.consentValidatorUrl) {
    if (abdmConfig.requireConsentValidation) {
      const error = new Error('External ABDM consent validation is required but ABDM_CONSENT_VALIDATOR_URL is not configured');
      error.statusCode = 503;
      error.code = 'ABDM_CONSENT_VALIDATOR_REQUIRED';
      throw error;
    }
    return { valid: false, skipped: true, structural, reason: 'ABDM_CONSENT_VALIDATOR_URL is not configured' };
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
        ? { Authorization: `Bearer ${process.env.ABDM_CONSENT_VALIDATOR_TOKEN}` }
        : {})
    },
    body: JSON.stringify({ artefact, environment: abdmConfig.environment, hipId: abdmConfig.hipId, hiuId: abdmConfig.hiuId }),
    signal: AbortSignal.timeout(Number(process.env.ABDM_CONSENT_VALIDATOR_TIMEOUT_MS || 15000)),
    redirect: 'error'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || `Consent validator failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    error.details = result;
    throw error;
  }
  const valid = result.valid === true && (result.signatureVerified === true || result.integrityVerified === true);
  if (!valid) {
    const error = new Error('Consent artefact signature/integrity validation failed');
    error.statusCode = 422;
    error.code = 'ABDM_CONSENT_SIGNATURE_INVALID';
    error.details = result;
    throw error;
  }
  return { ...result, valid: true, structural };
}

module.exports = { validateConsentArtefact, structuralConsentValidation };
