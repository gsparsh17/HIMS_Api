const crypto = require('crypto');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const { canonicalJson } = require('../utils/internalSignature');
const { normalizeInternalHiTypes } = require('../utils/abdmHiTypes');
const abdmConfig = require('../config/abdm.config');
const { encryptJson } = require('./abdmVault.service');

function hashArtifact(value) {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(value || {}))
    .digest('hex');
}

function normalizedStatus(value) {
  const status = String(value || 'PENDING').toUpperCase();
  const accepted = new Set([
    'DRAFT',
    'REQUESTED',
    'PENDING',
    'GRANTED',
    'DENIED',
    'REVOKED',
    'PAUSED',
    'EXPIRED',
    'FAILED'
  ]);
  return accepted.has(status) ? status : 'PENDING';
}

function extractConsent(payload = {}, role = 'HIP') {
  const notification = payload.notification || {};
  const detail = payload.consentDetail || payload.consent || payload.consentArtefact || {};
  const permission = detail.permission || notification.permission || payload.permission || {};
  const patient = detail.patient || notification.patient || payload.patient || {};
  const careContexts = detail.careContexts || notification.careContexts || [];

  return {
    role,
    consentRequestId:
      payload.consentRequestId ||
      payload.consentRequest?.id ||
      notification.consentRequestId,
    consentId:
      detail.id ||
      payload.consentId ||
      notification.consentId ||
      payload.consentArtefact?.id,
    artefactId: payload.consentArtefact?.id || detail.id,
    abhaAddress: patient.id || patient.abhaAddress || payload.abhaAddress,
    status: normalizedStatus(
      payload.status ||
        payload.consentRequest?.status ||
        notification.status ||
        detail.status
    ),
    purpose: permission.purpose || detail.purpose || payload.purpose,
    hiTypes: normalizeInternalHiTypes(
      permission.hiTypes || detail.hiTypes || payload.hiTypes || []
    ),
    dateRange: permission.dateRange || detail.dateRange || payload.dateRange,
    permission,
    careContextReferences: careContexts
      .map((item) => item.careContextReference || item.referenceNumber || item.id)
      .filter(Boolean),
    hipIds: [
      ...(Array.isArray(detail.hips) ? detail.hips : []),
      ...(Array.isArray(payload.hips) ? payload.hips : []),
      ...(detail.hip ? [detail.hip] : []),
      ...(payload.hip ? [payload.hip] : [])
    ]
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter(Boolean),
    hiuId: detail.hiu?.id || payload.hiu?.id,
    expiresAt:
      permission.dataEraseAt ||
      permission.permissionExpiry ||
      detail.expiresAt ||
      payload.expiresAt
  };
}

async function upsertConsent(payload, role = 'HIP', extra = {}) {
  const value = extractConsent(payload, role);
  const { storeArtefact = true, artefactHash: verifiedArtefactHash, ...persistedExtra } = extra;
  if (!persistedExtra.hospitalId) {
    throw new Error('hospitalId is required when storing ABDM consent');
  }
  if (!value.consentId && !value.consentRequestId) {
    throw new Error('Consent callback did not contain a consent identifier');
  }

  const identifiers = [
    ...(value.consentId ? [{ consentId: value.consentId }] : []),
    ...(value.consentRequestId
      ? [{ consentRequestId: value.consentRequestId }]
      : [])
  ];
  const query = { hospitalId: persistedExtra.hospitalId, role, $or: identifiers };

  const statusDates = {};
  if (value.status === 'GRANTED') statusDates.grantedAt = new Date();
  if (value.status === 'REVOKED') statusDates.revokedAt = new Date();

  const artefactIdentity = value.consentId || value.consentRequestId;
  const encryptedArtefact = encryptJson(
    payload,
    `abdm-consent:${persistedExtra.hospitalId}:${role}:${artefactIdentity}`
  );

  const update = {
    ...value,
    ...persistedExtra,
    sourceEnvelopeHash: hashArtifact(payload),
    lastCallbackAt: new Date(),
    ...statusDates
  };
  if (storeArtefact) {
    update.encryptedArtefact = encryptedArtefact;
    update.artefactHash = verifiedArtefactHash || hashArtifact(payload);
  }

  return AbdmHospitalConsent.findOneAndUpdate(
    query,
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function assertConsentUsable(consent) {
  if (!consent) {
    const error = new Error('Consent was not found');
    error.statusCode = 404;
    throw error;
  }
  if (
    abdmConfig.requireConsentValidation &&
    (consent.cryptographicallyValidated !== true ||
      consent.signatureValidated !== true ||
      consent.integrityValidated !== true ||
      !consent.validationId ||
      !consent.artefactHash)
  ) {
    const error = new Error('Consent artefact has not passed production cryptographic validation');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_CRYPTOGRAPHIC_VALIDATION_REQUIRED';
    throw error;
  }
  if (consent.status !== 'GRANTED') {
    const error = new Error(`Consent is ${consent.status}`);
    error.statusCode = 409;
    throw error;
  }
  if (consent.validFrom && new Date(consent.validFrom).getTime() > Date.now()) {
    const error = new Error('Consent is not yet valid');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_NOT_YET_VALID';
    throw error;
  }
  if (abdmConfig.requireConsentValidation && !consent.expiresAt) {
    const error = new Error('Consent expiry is missing');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_EXPIRY_REQUIRED';
    throw error;
  }
  if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= Date.now()) {
    const error = new Error('Consent has expired');
    error.statusCode = 410;
    error.code = 'ABDM_CONSENT_EXPIRED';
    throw error;
  }
}

function contextWithinRange(context, range = {}) {
  const from = range.from ? new Date(range.from).getTime() : null;
  const to = range.to ? new Date(range.to).getTime() : null;
  const contextFrom = context.dateFrom
    ? new Date(context.dateFrom).getTime()
    : null;
  const contextTo = context.dateTo
    ? new Date(context.dateTo).getTime()
    : contextFrom;
  if (from && contextTo && contextTo < from) return false;
  if (to && contextFrom && contextFrom > to) return false;
  return true;
}

function assertContextAllowed(consent, context) {
  assertConsentUsable(consent);
  const allowedTypes = normalizeInternalHiTypes(consent.hiTypes || []);
  if (allowedTypes.length && !allowedTypes.includes(context.hiType)) {
    throw new Error(`${context.hiType} is outside consent scope`);
  }
  const allowedRefs = new Set((consent.careContextReferences || []).map(String));
  if (allowedRefs.size && !allowedRefs.has(String(context.referenceNumber))) {
    throw new Error(`${context.referenceNumber} is outside consent scope`);
  }
  if (!contextWithinRange(context, consent.dateRange || {})) {
    throw new Error(`${context.referenceNumber} is outside consent date range`);
  }
}

module.exports = {
  normalizedStatus,
  extractConsent,
  upsertConsent,
  assertConsentUsable,
  assertContextAllowed,
  contextWithinRange,
  hashArtifact
};
