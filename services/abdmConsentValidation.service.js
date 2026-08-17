const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const { decryptJson } = require('./abdmVault.service');
const { masterRequest } = require('./abdmMasterClient.service');
const { requestInternalJson, checkInternalHealth } = require('./abdmInternalServiceClient');
const { hashArtifact, consentParts } = require('./abdmConsentPolicy.service');

const {
  identifier,
  asArray,
  purposeCode,
  assertVerifiedScopeMatches
} = require('./abdmConsentValidationContract');

function structuralConsentValidation(artefact = {}) {
  const { notification, envelope, detail, permission, patient, artefactIds } = consentParts(artefact);
  const value = detail && Object.keys(detail).length ? detail : envelope;
  const errors = [];
  const consentId =
    value.id ||
    value.consentId ||
    envelope.consentId ||
    artefact.consentId ||
    notification.consentId ||
    artefactIds[0];
  if (!consentId) errors.push({ code: 'CONSENT_ID_MISSING', path: 'consent.consentDetail.consentId', message: 'Consent identifier is missing' });
  if (!permission.dateRange?.from || !permission.dateRange?.to) {
    errors.push({ code: 'DATE_RANGE_MISSING', path: 'consent.consentDetail.permission.dateRange', message: 'Consent date range is missing' });
  }
  if (!permission.dataEraseAt && !permission.permissionExpiry && !value.expiresAt) {
    errors.push({ code: 'EXPIRY_MISSING', path: 'consent.consentDetail.permission.dataEraseAt', message: 'Consent expiry/data erase time is missing' });
  }
  const hiTypes = permission.hiTypes || value.hiTypes || envelope.hiTypes || artefact.hiTypes;
  if (!Array.isArray(hiTypes) || !hiTypes.length) {
    errors.push({ code: 'HI_TYPES_MISSING', path: 'consent.consentDetail.hiTypes', message: 'Consent HI types are missing' });
  }
  if (!identifier(patient) && !patient?.abhaAddress && !artefact.abhaAddress) {
    errors.push({ code: 'PATIENT_MISSING', path: 'consent.consentDetail.patient.id', message: 'Consent patient identity is missing' });
  }
  const hipIds = [
    ...asArray(value.hips || envelope.hips || artefact.hips),
    ...asArray(value.hip || envelope.hip || artefact.hip)
  ].map(identifier).filter(Boolean);
  const hiuId = identifier(value.hiu || envelope.hiu || artefact.hiu);
  if (!hipIds.length) {
    errors.push({ code: 'HIP_MISSING', path: 'consent.consentDetail.hip.id', message: 'Consent HIP identity is missing' });
  }
  if (!hiuId) {
    errors.push({ code: 'HIU_MISSING', path: 'consent.consentDetail.hiu.id', message: 'Consent HIU identity is missing' });
  }
  const purpose = permission.purpose || value.purpose || envelope.purpose || artefact.purpose;
  if (!purposeCode(purpose)) {
    errors.push({ code: 'PURPOSE_MISSING', path: 'consent.consentDetail.purpose.code', message: 'Consent purpose is missing' });
  }
  return { valid: errors.length === 0, errors };
}

function structuralSandboxDecision(artefact, structural, operation = {}, provider = 'structural-sandbox', warning) {
  const { notification, envelope, detail, permission, patient, careContexts, artefactIds } = consentParts(artefact);
  const value = detail && Object.keys(detail).length ? detail : envelope;
  const hipIds = [
    ...asArray(value.hips || envelope.hips || artefact.hips),
    ...asArray(value.hip || envelope.hip || artefact.hip)
  ].map(identifier).filter(Boolean);
  const consentId =
    value.id || value.consentId || envelope.consentId || artefact.consentId || notification.consentId || artefactIds[0];
  const status = String(value.status || envelope.status || artefact.status || notification.status || 'GRANTED').toUpperCase();
  const artefactHash = hashArtifact(artefact);
  const verifiedScope = {
    consentId: consentId ? String(consentId) : null,
    status,
    patientId: String(identifier(patient) || patient?.abhaAddress || artefact.abhaAddress || '').toLowerCase(),
    hipIds: Array.from(new Set(hipIds.map(String))),
    hiuId: identifier(value.hiu || envelope.hiu || artefact.hiu),
    purpose: permission.purpose || value.purpose || envelope.purpose || artefact.purpose,
    hiTypes: asArray(permission.hiTypes || value.hiTypes || envelope.hiTypes || artefact.hiTypes).map(String),
    careContextIds: asArray(careContexts)
      .map((item) => item?.careContextReference || item?.referenceNumber || identifier(item))
      .filter(Boolean)
      .map(String),
    dateRange: {
      from: permission.dateRange?.from || value.dateRange?.from || artefact.dateRange?.from || null,
      to: permission.dateRange?.to || value.dateRange?.to || artefact.dateRange?.to || null
    },
    validFrom: value.createdAt || envelope.createdAt || null,
    expiresAt: permission.permissionExpiry || value.expiresAt || permission.dataEraseAt || null,
    dataEraseAt: permission.dataEraseAt || null,
    frequency: permission.frequency || null,
    accessMode: permission.accessMode || null,
    retention: permission.retention || null
  };
  const authorizedOperationHash = hashArtifact({ artefactHash, operation, verifiedScope });
  return {
    valid: true,
    decision: 'PERMIT',
    provider,
    validationId: `sandbox:${artefactHash.slice(0, 24)}`,
    artefactHash,
    signatureVerified: false,
    integrityVerified: false,
    cryptographicallyValidated: false,
    unsignedSandbox: true,
    authorizedOperationHash,
    verifiedScope,
    trust: { issuer: null, keyId: null, algorithm: 'STRUCTURAL_SANDBOX' },
    lifecycleStatus: status,
    retentionUntil: verifiedScope.dataEraseAt || verifiedScope.expiresAt,
    usage: null,
    validatedAt: new Date().toISOString(),
    decisionExpiresAt: null,
    reasonCodes: [],
    warnings: warning ? [{ code: 'SANDBOX_STRUCTURAL_FALLBACK', message: warning }] : [],
    structural
  };
}

function selectedProvider(value) {
  const provider = String(value || abdmConfig.consentProvider || '').toLowerCase();
  if (!['master', 'local'].includes(provider)) {
    const error = new Error(`Unsupported ABDM consent provider: ${provider}`);
    error.code = 'ABDM_CONSENT_PROVIDER_INVALID';
    error.statusCode = 500;
    throw error;
  }
  return provider;
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

function providerConfigured(provider) {
  if (provider === 'master') return Boolean(abdmConfig.masterUrl);
  return Boolean(abdmConfig.consentValidatorUrl);
}

async function consentProviderRequest(provider, { type, body, reservationId, action }) {
  if (provider === 'master') {
    abdmConfig.assertHospitalConnector();
    if (type === 'validate') {
      return masterRequest('/internal/abdm/shared/consent/validate', {
        method: 'POST', timeoutMs: abdmConfig.sharedServiceTimeoutMs, body
      });
    }
    if (type === 'usage') {
      return masterRequest(`/internal/abdm/shared/consent/usage/${action}`, {
        method: 'POST', timeoutMs: abdmConfig.sharedServiceTimeoutMs, body: { reservationId }
      });
    }
    if (type === 'status') {
      return masterRequest('/internal/abdm/shared/consent/status-events', {
        method: 'POST', timeoutMs: abdmConfig.sharedServiceTimeoutMs, body
      });
    }
  }

  if (provider === 'local') {
    if (!abdmConfig.consentValidatorUrl) {
      const error = new Error('ABDM_CONSENT_VALIDATOR_URL is required when ABDM_CONSENT_PROVIDER=local');
      error.code = 'ABDM_LOCAL_CONSENT_NOT_CONFIGURED';
      error.statusCode = 503;
      throw error;
    }
    if (type === 'validate') {
      return requestInternalJson({
        url: validationEndpoint(),
        label: 'Hospital-local ABDM consent validator',
        allowedHosts: abdmConfig.consentValidatorAllowedHosts,
        timeoutMs: abdmConfig.consentValidatorTimeoutMs,
        maxResponseBytes: Number(process.env.ABDM_CONSENT_VALIDATOR_MAX_RESPONSE_BYTES || 1024 * 1024),
        headers: validatorHeaders(),
        body
      });
    }
    if (type === 'usage') {
      return requestInternalJson({
        url: validationEndpoint(`/v1/usage/${encodeURIComponent(reservationId)}/${action}`),
        label: `Hospital-local ABDM consent usage ${action}`,
        allowedHosts: abdmConfig.consentValidatorAllowedHosts,
        timeoutMs: abdmConfig.consentValidatorTimeoutMs,
        maxResponseBytes: 128 * 1024,
        headers: validatorHeaders(),
        body: {}
      });
    }
    if (type === 'status') {
      return requestInternalJson({
        url: validationEndpoint('/v1/status-events'),
        label: 'Hospital-local ABDM consent status event',
        allowedHosts: abdmConfig.consentValidatorAllowedHosts,
        timeoutMs: abdmConfig.consentValidatorTimeoutMs,
        maxResponseBytes: 128 * 1024,
        headers: validatorHeaders(),
        body
      });
    }
  }

  throw new Error(`Unsupported consent provider operation: ${provider}/${type}`);
}

function assertResult(result, operationType, options = {}) {
  const cryptographic = result.signatureVerified === true && result.integrityVerified === true;
  const unsignedSandboxAccepted = options.allowUnsignedSandbox === true && result.unsignedSandbox === true;
  const valid = result.valid === true && result.decision === 'PERMIT' && (cryptographic || unsignedSandboxAccepted);
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

  const operation = {
    type: 'REGISTER_ARTEFACT',
    operationId: `register:${hashArtifact(artefact)}`,
    ...(options.operation || {})
  };
  const role = String(options.role || '').toUpperCase();
  const expected = {
    ...(role === 'HIP' ? { hipId: abdmConfig.hipId } : {}),
    hiuId: abdmConfig.hiuId,
    ...(options.expected || {})
  };

  const provider = selectedProvider(options.provider);
  if (!providerConfigured(provider)) {
    if (abdmConfig.requireConsentValidation || abdmConfig.isProduction) {
      const error = new Error(`External ABDM consent validation is required but provider ${provider} is not configured`);
      error.statusCode = 503;
      error.code = 'ABDM_CONSENT_VALIDATOR_REQUIRED';
      throw error;
    }
    const fallback = structuralSandboxDecision(
      artefact,
      structural,
      operation,
      'structural-sandbox',
      `ABDM consent provider ${provider} is not configured; using sandbox structural validation only`
    );
    assertVerifiedScopeMatches(fallback, operation, expected);
    return fallback;
  }
  try {
    const result = await consentProviderRequest(provider, {
      type: 'validate',
      body: {
        artefact,
        environment: abdmConfig.environment,
        operation,
        expected
      }
    });

    const accepted = assertResult(result, operation.type, {
      allowUnsignedSandbox: !abdmConfig.requireConsentValidation && !abdmConfig.isProduction
    });
    assertVerifiedScopeMatches(accepted, operation, expected);
    return {
      valid: true,
      decision: 'PERMIT',
      provider,
      validationId: accepted.validationId,
      artefactHash: accepted.artefactHash,
      signatureVerified: accepted.signatureVerified === true,
      integrityVerified: accepted.integrityVerified === true,
      cryptographicallyValidated:
        accepted.signatureVerified === true && accepted.integrityVerified === true,
      authorizedOperationHash: accepted.authorizedOperationHash,
      verifiedScope: accepted.verifiedScope,
      trust: accepted.trust,
      lifecycleStatus: accepted.lifecycleStatus,
      retentionUntil: accepted.retentionUntil,
      usage: accepted.usage ? { ...accepted.usage, provider } : null,
      validatedAt: accepted.validatedAt,
      decisionExpiresAt: accepted.decisionExpiresAt,
      reasonCodes: [],
      unsignedSandbox: accepted.unsignedSandbox === true,
      warnings: Array.isArray(accepted.warnings) ? accepted.warnings.slice(0, 100) : [],
      structural
    };
  } catch (error) {
    if (abdmConfig.requireConsentValidation || abdmConfig.isProduction) throw error;
    const fallback = structuralSandboxDecision(
      artefact,
      structural,
      operation,
      'structural-sandbox',
      `External consent validator could not produce a sandbox decision: ${error.message}`
    );
    assertVerifiedScopeMatches(fallback, operation, expected);
    return fallback;
  }
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
    role: stored.role,
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

function usageContext(reservationOrUsage, providerOverride) {
  if (!reservationOrUsage) return { reservationId: null, provider: selectedProvider(providerOverride) };
  if (typeof reservationOrUsage === 'object') {
    return {
      reservationId: reservationOrUsage.reservationId,
      provider: selectedProvider(providerOverride || reservationOrUsage.provider)
    };
  }
  // Backward compatibility for reservations created before provider affinity was persisted.
  return { reservationId: reservationOrUsage, provider: selectedProvider(providerOverride) };
}

async function usageAction(reservationOrUsage, action, providerOverride) {
  const { reservationId, provider } = usageContext(reservationOrUsage, providerOverride);
  if (!reservationId) return { skipped: true, provider };
  if (!['commit', 'release'].includes(action)) throw new Error(`Unsupported consent usage action: ${action}`);
  return consentProviderRequest(provider, { type: 'usage', reservationId, action });
}

async function commitConsentUsage(reservationOrUsage, providerOverride) {
  return usageAction(reservationOrUsage, 'commit', providerOverride);
}

async function releaseConsentUsage(reservationOrUsage, providerOverride) {
  return usageAction(reservationOrUsage, 'release', providerOverride);
}

async function recordConsentStatusEvent(consent, extra = {}) {
  if (!consent?.consentId) return { skipped: true };
  const provider = selectedProvider(
    extra.provider || consent.metadata?.consentValidation?.provider || consent.metadata?.consentAuthorization?.provider
  );
  if (!providerConfigured(provider)) return { skipped: true, provider };
  return consentProviderRequest(provider, {
    type: 'status',
    body: {
      consentId: consent.consentId,
      status: consent.status,
      effectiveAt: consent.revokedAt || consent.lastCallbackAt || consent.updatedAt || new Date(),
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

function productionCapableFromHealth(health) {
  const capabilities = health.capabilities || {};
  return Boolean(
    health.healthy === true &&
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
}

async function masterConsentHealth() {
  if (!abdmConfig.masterUrl) {
    return { configured: false, healthy: false, productionCapable: false, provider: 'master', location: 'MEDIQLIQ_MASTER' };
  }
  try {
    const response = await masterRequest('/internal/abdm/shared/health', {
      method: 'GET',
      timeoutMs: Math.min(abdmConfig.sharedServiceTimeoutMs || 30000, 5000)
    });
    const health = response?.services?.consentValidator || {};
    return {
      ...health,
      configured: health.configured !== false,
      healthy: health.healthy === true,
      productionCapable: productionCapableFromHealth(health),
      provider: 'master',
      location: 'MEDIQLIQ_MASTER',
      checkedAt: health.checkedAt || response?.checkedAt || new Date().toISOString()
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      productionCapable: false,
      provider: 'master',
      location: 'MEDIQLIQ_MASTER',
      checkedAt: new Date().toISOString(),
      errorCode: error.code || 'ABDM_MASTER_SHARED_CONSENT_UNREACHABLE'
    };
  }
}

async function localConsentHealth() {
  const healthUrl = abdmConfig.consentValidatorHealthUrl || validationEndpoint('/health/ready');
  const health = await checkInternalHealth({
    url: healthUrl,
    label: 'Hospital-local ABDM consent validator health',
    allowedHosts: abdmConfig.consentValidatorAllowedHosts,
    timeoutMs: Math.min(abdmConfig.consentValidatorTimeoutMs, 5000)
  });
  return {
    ...health,
    provider: 'local',
    location: 'HOSPITAL_LOCAL',
    productionCapable: productionCapableFromHealth(health)
  };
}

async function checkConsentValidatorHealth(provider = abdmConfig.consentProvider) {
  return selectedProvider(provider) === 'local' ? localConsentHealth() : masterConsentHealth();
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
  assertVerifiedScopeMatches,
  selectedProvider,
  usageContext
};
