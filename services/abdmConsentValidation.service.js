const abdmConfig = require('../config/abdm.config');
const {
  requestInternalJson,
  checkInternalHealth
} = require('./abdmInternalServiceClient');

function structuralConsentValidation(artefact = {}) {
  const value = artefact.consentDetail || artefact.consent || artefact.consentArtefact || artefact.notification || artefact;
  const permission = value.permission || artefact.permission || {};
  const errors = [];
  const consentId = value.id || artefact.consentId || artefact.notification?.consentId;
  if (!consentId) errors.push({ code: 'CONSENT_ID_MISSING', path: 'consent.id', message: 'Consent identifier is missing' });
  if (!permission.dateRange?.from || !permission.dateRange?.to) {
    errors.push({ code: 'DATE_RANGE_MISSING', path: 'permission.dateRange', message: 'Consent date range is missing' });
  }
  if (!permission.dataEraseAt && !permission.permissionExpiry && !value.expiresAt) {
    errors.push({ code: 'EXPIRY_MISSING', path: 'permission.dataEraseAt', message: 'Consent expiry/data erase time is missing' });
  }
  const hiTypes = permission.hiTypes || value.hiTypes || artefact.hiTypes;
  if (!Array.isArray(hiTypes) || !hiTypes.length) {
    errors.push({ code: 'HI_TYPES_MISSING', path: 'permission.hiTypes', message: 'Consent HI types are missing' });
  }
  const patient = value.patient || artefact.patient;
  if (!patient?.id && !patient?.abhaAddress && !artefact.abhaAddress) {
    errors.push({ code: 'PATIENT_MISSING', path: 'patient.id', message: 'Consent patient identity is missing' });
  }
  const hip = value.hip || artefact.hip;
  const hiu = value.hiu || artefact.hiu;
  if (!hip?.id && !Array.isArray(value.hips)) {
    errors.push({ code: 'HIP_MISSING', path: 'hip.id', message: 'Consent HIP identity is missing' });
  }
  if (!hiu?.id) {
    errors.push({ code: 'HIU_MISSING', path: 'hiu.id', message: 'Consent HIU identity is missing' });
  }
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
    return {
      valid: false,
      signatureVerified: false,
      skipped: true,
      structural,
      reason: 'ABDM_CONSENT_VALIDATOR_URL is not configured'
    };
  }

  const result = await requestInternalJson({
    url: abdmConfig.consentValidatorUrl,
    label: 'ABDM consent validator',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: abdmConfig.consentValidatorTimeoutMs,
    maxResponseBytes: Number(process.env.ABDM_CONSENT_VALIDATOR_MAX_RESPONSE_BYTES || 1024 * 1024),
    headers: process.env.ABDM_CONSENT_VALIDATOR_TOKEN
      ? { Authorization: `Bearer ${process.env.ABDM_CONSENT_VALIDATOR_TOKEN}` }
      : {},
    body: {
      artefact,
      environment: abdmConfig.environment,
      expected: {
        hipId: abdmConfig.hipId,
        hiuId: abdmConfig.hiuId
      }
    }
  });

  const valid = result.valid === true && (
    result.signatureVerified === true || result.integrityVerified === true
  );
  if (!valid) {
    const error = new Error(result.reason || 'Consent artefact signature/integrity validation failed');
    error.statusCode = 422;
    error.code = result.reason || 'ABDM_CONSENT_SIGNATURE_INVALID';
    error.details = {
      valid: false,
      signatureVerified: result.signatureVerified === true,
      reason: result.reason || 'VALIDATION_FAILED',
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 100) : []
    };
    throw error;
  }
  return {
    valid: true,
    signatureVerified: true,
    status: result.status || null,
    reason: null,
    errors: [],
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 100) : [],
    structural
  };
}

async function checkConsentValidatorHealth() {
  const healthUrl = abdmConfig.consentValidatorHealthUrl || (
    abdmConfig.consentValidatorUrl
      ? new URL('/health', `${abdmConfig.consentValidatorUrl}/`).toString()
      : ''
  );
  return checkInternalHealth({
    url: healthUrl,
    label: 'ABDM consent validator health',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: Math.min(abdmConfig.consentValidatorTimeoutMs, 5000)
  });
}

module.exports = {
  validateConsentArtefact,
  structuralConsentValidation,
  checkConsentValidatorHealth
};
