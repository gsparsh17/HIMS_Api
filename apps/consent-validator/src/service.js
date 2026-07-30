const crypto = require('crypto');
const { config } = require('./config');
const { normalizeConsent } = require('./normalize');
const { verifyConsentProof } = require('./trust');
const { evaluatePolicy } = require('./policy');
const { hashIdentifier, sha256, canonicalJson } = require('./canonical');
const {
  ConsentStatusEvent,
  ConsentValidationDecision
} = require('./models');
const {
  reserveUsage,
  commitReservation,
  releaseReservation
} = require('./usage');

function consentHash(value) {
  return hashIdentifier(value, config.identifierPepper);
}

async function latestLifecycleStatus(consentId) {
  const consentIdHash = consentHash(consentId);
  const event = await ConsentStatusEvent.findOne({ consentIdHash })
    .sort({ effectiveAt: -1, createdAt: -1 })
    .lean();
  return event?.status || null;
}

async function saveDecision({ validationId, operationHash, claims, proof, policy, reservation }) {
  return ConsentValidationDecision.create({
    validationId,
    operationHash,
    consentIdHash: consentHash(claims.consentId),
    artefactHash: proof.artefactHash,
    decision: policy.decision,
    reasonCodes: policy.issues.map((item) => item.code),
    operationType: policy.type,
    trust: proof.trust,
    reservationId: reservation?.reservationId,
    retentionUntil: policy.retentionUntil ? new Date(policy.retentionUntil) : undefined,
    expiresAt: new Date(Date.now() + config.decisionTtlSeconds * 1000)
  });
}

async function validateConsent(request = {}) {
  const proof = await verifyConsentProof(request);
  const normalized = normalizeConsent(proof.verifiedArtefact);
  if (!normalized.valid) {
    const error = new Error('Consent artefact is structurally invalid');
    error.code = 'CONSENT_ARTEFACT_INVALID';
    error.statusCode = 422;
    error.details = { errors: normalized.errors };
    throw error;
  }
  const lifecycleStatus = await latestLifecycleStatus(normalized.claims.consentId);
  const policy = evaluatePolicy({
    claims: normalized.claims,
    operation: request.operation || {},
    expected: request.expected || {},
    lifecycleStatus
  });
  const validationId = crypto.randomUUID();
  const authorizedOperationHash = sha256(canonicalJson({
    artefactHash: proof.artefactHash,
    scopeAndOperationHash: policy.authorizedOperationHash
  }));
  let reservation = null;
  if (
    policy.decision === 'PERMIT' &&
    policy.frequency &&
    config.consumeFrequencyFor.has(policy.type)
  ) {
    reservation = await reserveUsage({
      consentIdHash: consentHash(normalized.claims.consentId),
      operationType: policy.type,
      operationHash: authorizedOperationHash,
      frequency: policy.frequency
    });
  }
  await saveDecision({
    validationId,
    operationHash: authorizedOperationHash,
    claims: normalized.claims,
    proof,
    policy,
    reservation
  });

  return {
    valid: policy.decision === 'PERMIT',
    decision: policy.decision,
    validationId,
    artefactHash: proof.artefactHash,
    signatureVerified: proof.signatureVerified,
    integrityVerified: proof.integrityVerified,
    unsignedSandbox: proof.unsignedSandbox,
    trust: proof.trust,
    verifiedScope: normalized.claims,
    lifecycleStatus: lifecycleStatus || normalized.claims.status,
    usage: reservation
      ? {
          reservationId: reservation.reservationId,
          status: reservation.status,
          expiresAt: reservation.expiresAt
        }
      : null,
    retentionUntil: policy.retentionUntil,
    authorizedOperationHash,
    reasonCodes: policy.issues.map((item) => item.code),
    errors: policy.issues,
    validatedAt: new Date().toISOString(),
    decisionExpiresAt: new Date(
      Date.now() + config.decisionTtlSeconds * 1000
    ).toISOString()
  };
}

async function recordStatusEvent(body = {}) {
  const consentId = body.consentId;
  const status = String(body.status || '').toUpperCase();
  if (!consentId) {
    const error = new Error('consentId is required');
    error.code = 'CONSENT_ID_MISSING';
    error.statusCode = 400;
    throw error;
  }
  if (!['GRANTED', 'DENIED', 'REVOKED', 'EXPIRED', 'PAUSED', 'REQUESTED', 'PENDING'].includes(status)) {
    const error = new Error('Unsupported consent status');
    error.code = 'CONSENT_STATUS_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : new Date();
  if (Number.isNaN(effectiveAt.getTime())) {
    const error = new Error('effectiveAt is invalid');
    error.code = 'CONSENT_STATUS_TIME_INVALID';
    error.statusCode = 400;
    throw error;
  }
  const eventIdentity = body.eventId || sha256(canonicalJson({
    consentId,
    status,
    effectiveAt: effectiveAt.toISOString(),
    artefactHash: body.artefactHash || null
  }));
  const event = await ConsentStatusEvent.findOneAndUpdate(
    { sourceEventIdHash: consentHash(eventIdentity) },
    {
      consentIdHash: consentHash(consentId),
      artefactHash: body.artefactHash,
      status,
      effectiveAt,
      sourceEventIdHash: consentHash(eventIdentity),
      source: body.source || 'HOSPITAL_BACKEND',
      metadata: body.metadata
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return {
    accepted: true,
    status: event.status,
    effectiveAt: event.effectiveAt,
    eventIdHash: event.sourceEventIdHash
  };
}

module.exports = {
  validateConsent,
  recordStatusEvent,
  commitReservation,
  releaseReservation,
  latestLifecycleStatus
};
