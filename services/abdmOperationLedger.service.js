'use strict';

const crypto = require('crypto');
const AbdmOperationLedger = require('../models/AbdmOperationLedger');
const { cloneAndRedact, redactSensitiveText } = require('../utils/sensitiveData');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
function fingerprint(value) {
  const secret = String(
    process.env.ABDM_OPERATION_FINGERPRINT_SECRET ||
    process.env.PLATFORM_CONNECTOR_SECRET ||
    process.env.JWT_SECRET ||
    ''
  );
  if (!secret && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    const error = new Error('ABDM_OPERATION_FINGERPRINT_SECRET (or another server secret) is required in production');
    error.code = 'ABDM_FINGERPRINT_SECRET_REQUIRED';
    throw error;
  }
  // HMAC the original request/response representation so idempotency still
  // distinguishes different sensitive values without storing those values.
  return crypto.createHmac('sha256', secret || 'development-only-abdm-fingerprint')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}
function requestOperationId(req, action) {
  const supplied = String(req.headers?.['x-mediqliq-operation-id'] || req.body?.operationId || '').trim();
  if (supplied) return supplied.slice(0, 120);
  return `ABDM-${String(action || 'OP').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}-${crypto.randomUUID()}`;
}

async function beginOperation({ req, patient, flow, action, requestSummary, consentEvidenceHash }) {
  const operationId = requestOperationId(req, action);
  const existing = await AbdmOperationLedger.findOne({ operationId });
  if (existing) {
    const sameOwner = String(existing.patientId) === String(patient._id) && String(existing.hospitalId) === String(patient.hospitalId) && String(existing.userId) === String(req.user?._id);
    if (!sameOwner) {
      const error = new Error('ABDM operation id is already bound to a different security context');
      error.statusCode = 409; error.code = 'ABDM_OPERATION_ID_CONFLICT'; throw error;
    }
    const expectedFingerprint = fingerprint(requestSummary || {});
    if (existing.requestFingerprint && existing.requestFingerprint !== expectedFingerprint) {
      const error = new Error('ABDM operation id was reused with a different request payload');
      error.statusCode = 409; error.code = 'ABDM_OPERATION_PAYLOAD_CONFLICT'; throw error;
    }
    existing.$idempotent = true;
    return existing;
  }
  return AbdmOperationLedger.create({
    operationId,
    hospitalId: patient.hospitalId,
    patientId: patient._id,
    userId: req.user._id,
    flow,
    action,
    status: 'CREATED',
    requestId: req.requestId || req.headers?.['x-request-id'] || crypto.randomUUID(),
    requestFingerprint: fingerprint(requestSummary || {}),
    consentEvidenceHash,
    attempts: 0
  });
}

async function beforeExternal(operation) {
  if (operation.$idempotent && operation.status !== 'CREATED') return operation;
  operation.status = 'SENT';
  operation.attempts = Number(operation.attempts || 0) + 1;
  operation.lastAttemptAt = new Date();
  await operation.save();
  return operation;
}

async function externalAccepted(operation, response, { txnId } = {}) {
  operation.status = 'EXTERNAL_ACCEPTED';
  operation.externalAcceptedAt = new Date();
  operation.externalTxnId = txnId || response?.txnId || response?.transactionId || operation.externalTxnId;
  operation.externalResponseFingerprint = fingerprint(response || {});
  await operation.save();
  return operation;
}

async function externalFailed(operation, error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  const definitiveReject = statusCode >= 400 && statusCode < 500;
  operation.status = definitiveReject ? 'FAILED' : 'UNKNOWN';
  operation.lastError = { code: error?.code, message: redactSensitiveText(String(error?.message || error)).slice(0, 1000), at: new Date() };
  if (!definitiveReject) {
    operation.reconciliation = { ...(operation.reconciliation?.toObject?.() || operation.reconciliation || {}), requiredAt: new Date(), reason: 'External outcome is ambiguous after transport/process failure' };
  }
  await operation.save().catch(() => {});
}

async function localCommitted(operation, resultRef = {}) {
  operation.status = 'LOCAL_COMMITTED';
  operation.localCommittedAt = new Date();
  operation.resultRef = cloneAndRedact(resultRef);
  await operation.save();
}

async function completeOperation(operation, resultRef = {}) {
  operation.status = 'COMPLETED';
  operation.completedAt = new Date();
  operation.resultRef = { ...(operation.resultRef || {}), ...cloneAndRedact(resultRef) };
  operation.reconciliation = { ...(operation.reconciliation?.toObject?.() || operation.reconciliation || {}), resolvedAt: new Date(), resolution: 'COMPLETED' };
  await operation.save();
}

async function requireReconciliation(operation, reason, error) {
  operation.status = 'RECONCILIATION_REQUIRED';
  operation.reconciliation = { ...(operation.reconciliation?.toObject?.() || operation.reconciliation || {}), requiredAt: new Date(), reason: String(reason || 'Local commit incomplete').slice(0, 1000) };
  if (error) operation.lastError = { code: error.code, message: redactSensitiveText(String(error.message || error)).slice(0, 1000), at: new Date() };
  await operation.save().catch(() => {});
}

function assertSafeIdempotentReplay(operation) {
  if (!operation?.$idempotent) return;
  if (['CREATED', 'COMPLETED'].includes(operation.status)) return;
  const error = new Error('This ABDM operation already reached an external/ambiguous state and must be reconciled instead of retried blindly');
  error.statusCode = 409;
  error.code = 'ABDM_RECONCILIATION_REQUIRED';
  error.operationId = operation.operationId;
  error.status = operation.status;
  throw error;
}

module.exports = {
  sha256,
  fingerprint,
  beginOperation,
  beforeExternal,
  externalAccepted,
  externalFailed,
  localCommitted,
  completeOperation,
  requireReconciliation,
  assertSafeIdempotentReplay
};
