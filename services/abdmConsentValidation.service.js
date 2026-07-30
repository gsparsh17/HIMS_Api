const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const { decryptJson } = require('./abdmVault.service');
const {
  requestInternalJson,
  checkInternalHealth
} = require('./abdmInternalServiceClient');
const { hashArtifact } = require('./abdmConsentPolicy.service');

const {
  identifier,
  asArray,
  purposeCode,
  assertVerifiedScopeMatches
} = require('./abdmConsentValidationContract');

function structuralConsentValidation(artefact = {}) {
  const value =
    artefact.consentDetail ||
    artefact.consent ||
    artefact.consentArtefact ||
    artefact.notification?.consentDetail ||
    artefact.notification?.consentArtefact ||
    artefact.notification ||
    artefact;
  const permission = value.permission || artefact.permission || {};
  const errors = [];
  const consentId = value.id || value.consentId || artefact.consentId || artefact.notification?.consentId;
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
  if (!identifier(patient) && !patient?.abhaAddress && !artefact.abhaAddress) {
    errors.push({ code: 'PATIENT_MISSING', path: 'patient.id', message: 'Consent patient identity is missing' });
  }
  const hipIds = [
    ...asArray(value.hips || artefact.hips),
    ...asArray(value.hip || artefact.hip)
  ].map(identifier).filter(Boolean);
  const hiuId = identifier(value.hiu || artefact.hiu);
  if (!hipIds.length) {
    errors.push({ code: 'HIP_MISSING', path: 'hip.id', message: 'Consent HIP identity is missing' });
  }
  if (!hiuId) {
    errors.push({ code: 'HIU_MISSING', path: 'hiu.id', message: 'Consent HIU identity is missing' });
  }
  const purpose = permission.purpose || value.purpose || artefact.purpose;
  if (!purposeCode(purpose)) {
    errors.push({ code: 'PURPOSE_MISSING', path: 'purpose.code', message: 'Consent purpose is missing' });
  }
  return { valid: errors.length === 0, errors };
}

function validatorHeaders() {
  return process.env.ABDM_CONSENT_VALIDATOR_TOKEN
    ? { Authorization: `Bearer ${process.env.ABDM_CONSENT_VALIDATOR_TOKEN}` }
    : {};
}

function validationEndpoint(path = '') {
  if (!abdmConfig.consentValidatorUrl) return '';
  const configured = new URL(abdmConfig.consentValidatorUrl);
  if (!path) return configured.toString();
  return new URL(path, `${configured.origin}/`).toString();
}

function assertResult(result, operationType) {
  const cryptographic = result.signatureVerified === true && result.integrityVerified === true;
  const valid = result.valid === true && result.decision === 'PERMIT' && cryptographic;
  if (!valid) {
    const error = new Error(
      result.errors?.[0]?.message ||
      result.reasonCodes?.[0] ||
      'Consent artefact or operation authorization failed'
    );
    error.statusCode = 422;
    error.code = result.reasonCodes?.[0] || result.code || 'ABDM_CONSENT_VALIDATION_FAILED';
    error.details = {
      valid: false,
      decision: result.decision,
      signatureVerified: result.signatureVerified === true,
      integrityVerified: result.integrityVerified === true,
      operationType,
      reasonCodes: Array.isArray(result.reasonCodes) ? result.reasonCodes.slice(0, 100) : [],
      errors: Array.isArray(result.errors) ? result.errors.slice(0, 100) : []
    };
    throw error;
  }
  if (!result.validationId || !result.artefactHash || !result.authorizedOperationHash) {
    const error = new Error('Consent validator response is missing decision evidence');
    error.statusCode = 502;
    error.code = 'ABDM_CONSENT_VALIDATOR_RESPONSE_INVALID';
    throw error;
  }
  return result;
}

async function validateConsentArtefact(artefact, options = {}) {
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
      decision: 'DENY',
      signatureVerified: false,
      integrityVerified: false,
      skipped: true,
      structural,
      reason: 'ABDM_CONSENT_VALIDATOR_URL is not configured'
    };
  }

  const operation = {
    type: 'REGISTER_ARTEFACT',
    operationId: `register:${hashArtifact(artefact)}`,
    ...(options.operation || {})
  };
  const expected = {
    hipId: abdmConfig.hipId,
    hiuId: abdmConfig.hiuId,
    ...(options.expected || {})
  };

  const result = await requestInternalJson({
    url: validationEndpoint(),
    label: 'ABDM consent validator',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: abdmConfig.consentValidatorTimeoutMs,
    maxResponseBytes: Number(process.env.ABDM_CONSENT_VALIDATOR_MAX_RESPONSE_BYTES || 1024 * 1024),
    headers: validatorHeaders(),
    body: {
      artefact,
      environment: abdmConfig.environment,
      operation,
      expected
    }
  });

  const accepted = assertResult(result, operation.type);
  assertVerifiedScopeMatches(accepted, operation, expected);
  return {
    valid: true,
    decision: 'PERMIT',
    validationId: accepted.validationId,
    artefactHash: accepted.artefactHash,
    signatureVerified: accepted.signatureVerified === true,
    integrityVerified: accepted.integrityVerified === true,
    cryptographicallyValidated: true,
    authorizedOperationHash: accepted.authorizedOperationHash,
    verifiedScope: accepted.verifiedScope,
    trust: accepted.trust,
    lifecycleStatus: accepted.lifecycleStatus,
    retentionUntil: accepted.retentionUntil,
    usage: accepted.usage || null,
    validatedAt: accepted.validatedAt,
    decisionExpiresAt: accepted.decisionExpiresAt,
    reasonCodes: [],
    warnings: Array.isArray(accepted.warnings) ? accepted.warnings.slice(0, 100) : [],
    structural
  };
}

async function consentWithEncryptedArtefact(consent) {
  if (!consent?._id) throw new Error('Consent record is required');
  return AbdmHospitalConsent.findById(consent._id).select(
    '+encryptedArtefact.ciphertext +encryptedArtefact.iv +encryptedArtefact.tag +encryptedArtefact.keyVersion'
  );
}

async function authorizeConsentOperation({ consent, operation }) {
  const stored = await consentWithEncryptedArtefact(consent);
  if (!stored?.encryptedArtefact?.ciphertext) {
    const error = new Error('Encrypted consent artefact is unavailable for operation authorization');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_ARTEFACT_UNAVAILABLE';
    throw error;
  }
  const artefact = decryptJson(
    stored.encryptedArtefact,
    `abdm-consent:${stored.hospitalId}:${stored.role}:${stored.consentId || stored.consentRequestId}`
  );
  const authorization = await validateConsentArtefact(artefact, {
    operation,
    expected: {
      consentId: stored.consentId,
      patientId: stored.abhaAddress,
      hipId: operation.hipId || (stored.role === 'HIP' ? abdmConfig.hipId : undefined),
      hiuId: operation.hiuId || stored.hiuId || abdmConfig.hiuId,
      hospitalId: String(stored.hospitalId)
    }
  });
  if (stored.artefactHash && stored.artefactHash !== authorization.artefactHash) {
    const error = new Error('Stored consent artefact hash does not match the cryptographically verified artefact');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_ARTEFACT_HASH_MISMATCH';
    throw error;
  }
  return authorization;
}

async function usageAction(reservationId, action) {
  if (!reservationId) return { skipped: true };
  return requestInternalJson({
    url: validationEndpoint(`/v1/usage/${encodeURIComponent(reservationId)}/${action}`),
    label: `ABDM consent usage ${action}`,
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: abdmConfig.consentValidatorTimeoutMs,
    maxResponseBytes: 128 * 1024,
    headers: validatorHeaders(),
    body: {}
  });
}

async function commitConsentUsage(reservationId) {
  return usageAction(reservationId, 'commit');
}

async function releaseConsentUsage(reservationId) {
  return usageAction(reservationId, 'release');
}

async function recordConsentStatusEvent(consent, extra = {}) {
  if (!abdmConfig.consentValidatorUrl || !consent?.consentId) return { skipped: true };
  return requestInternalJson({
    url: validationEndpoint('/v1/status-events'),
    label: 'ABDM consent status event',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: abdmConfig.consentValidatorTimeoutMs,
    maxResponseBytes: 128 * 1024,
    headers: validatorHeaders(),
    body: {
      consentId: consent.consentId,
      status: consent.status,
      effectiveAt:
        consent.revokedAt || consent.lastCallbackAt || consent.updatedAt || new Date(),
      artefactHash: consent.artefactHash,
      eventId: extra.eventId || `${consent.consentId}:${consent.status}:${consent.lastCallbackAt || consent.updatedAt}`,
      source: 'HOSPITAL_BACKEND',
      metadata: {
        role: consent.role,
        validationId: consent.validationId || consent.metadata?.consentValidation?.validationId
      }
    }
  });
}

async function checkConsentValidatorHealth() {
  const healthUrl = abdmConfig.consentValidatorHealthUrl || validationEndpoint('/health/ready');
  const health = await checkInternalHealth({
    url: healthUrl,
    label: 'ABDM consent validator health',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: Math.min(abdmConfig.consentValidatorTimeoutMs, 5000)
  });
  const capabilities = health.capabilities || {};
  const productionCapable = Boolean(
    health.healthy &&
      health.trustReady !== false &&
      health.databaseReady !== false &&
      capabilities.signatureVerification === true &&
      capabilities.integrityVerification === true &&
      capabilities.lifecycleValidation === true &&
      capabilities.scopeValidation === true &&
      capabilities.purposeValidation === true &&
      capabilities.hiTypeValidation === true &&
      capabilities.identityValidation === true &&
      capabilities.frequencyEnforcement === true &&
      capabilities.retentionEnforcement === true &&
      capabilities.durableUsageLedger === true &&
      capabilities.operationBinding === true
  );
  return { ...health, productionCapable };
}

module.exports = {
  validateConsentArtefact,
  authorizeConsentOperation,
  commitConsentUsage,
  releaseConsentUsage,
  recordConsentStatusEvent,
  structuralConsentValidation,
  checkConsentValidatorHealth,
  assertResult,
  assertVerifiedScopeMatches
};
