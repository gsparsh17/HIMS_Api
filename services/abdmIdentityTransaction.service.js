const crypto = require('crypto');
const AbdmIdentityTransaction = require('../models/AbdmIdentityTransaction');
const abdmConfig = require('../config/abdm.config');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function requestContext(req) {
  return {
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    sourceIpHash: sha256(req.ip),
    userAgentHash: sha256(req.headers['user-agent'])
  };
}

function consentEvidence(req, { patientId, code, version, text }) {
  if (!req.body?.consentAccepted) {
    const error = new Error('Explicit patient consent is required');
    error.statusCode = 400;
    throw error;
  }
  return {
    code,
    version,
    textHash: sha256(text || `${code}:${version}`),
    acceptedAt: new Date(),
    acceptedByUserId: req.user?._id,
    patientId,
    sourceIp: sha256(req.ip),
    userAgent: sha256(req.headers['user-agent'])
  };
}

async function createTransaction({
  txnId,
  flow,
  patient,
  userId,
  consent,
  selectedIndex,
  metadata,
  req
}) {
  if (!txnId) throw new Error('ABDM response did not include a transaction ID');
  const ttlMs = abdmConfig.identityTransactionTtlMinutes * 60 * 1000;
  const existing = await AbdmIdentityTransaction.findOne({ txnId });
  if (existing) {
    const sameOwner =
      String(existing.patientId) === String(patient._id) &&
      String(existing.userId) === String(userId) &&
      String(existing.hospitalId) === String(patient.hospitalId) &&
      existing.flow === flow;
    if (!sameOwner) {
      const error = new Error('ABDM transaction ID is already bound to another owner');
      error.statusCode = 409;
      throw error;
    }
    return existing;
  }

  try {
    return await AbdmIdentityTransaction.create({
      txnId,
      flow,
      patientId: patient._id,
      userId,
      hospitalId: patient.hospitalId,
      status: 'OTP_REQUESTED',
      selectedIndex,
      maxAttempts: abdmConfig.otpMaxAttempts,
      lastOtpSentAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
      consent,
      requestContext: req ? requestContext(req) : undefined,
      metadata
    });
  } catch (error) {
    if (error.code === 11000) {
      const conflict = new Error('Duplicate ABDM transaction was rejected');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
}

async function getOwnedTransaction({ txnId, patient, userId, flows = [] }) {
  const transaction = await AbdmIdentityTransaction.findOne({
    txnId,
    patientId: patient._id,
    hospitalId: patient.hospitalId,
    userId,
    ...(flows.length ? { flow: { $in: flows } } : {})
  });

  if (!transaction) {
    const error = new Error('ABDM transaction does not belong to this patient/session');
    error.statusCode = 403;
    throw error;
  }
  if (transaction.expiresAt.getTime() <= Date.now()) {
    transaction.status = 'EXPIRED';
    await transaction.save();
    const error = new Error('ABDM transaction has expired');
    error.statusCode = 410;
    throw error;
  }
  if (transaction.status === 'LOCKED') {
    const error = new Error('ABDM transaction is locked after excessive attempts');
    error.statusCode = 423;
    throw error;
  }
  return transaction;
}

async function assertResendAllowed(transaction) {
  const nextAllowedAt = new Date(transaction.lastOtpSentAt).getTime() +
    abdmConfig.otpResendSeconds * 1000;
  if (Date.now() < nextAllowedAt) {
    const error = new Error(
      `OTP can be resent after ${Math.ceil((nextAllowedAt - Date.now()) / 1000)} seconds`
    );
    error.statusCode = 429;
    throw error;
  }
}

async function recordAttempt(transaction, error) {
  if (error?.countAttempt !== false) transaction.attempts += 1;
  transaction.lastAttemptAt = new Date();
  if (error?.countAttempt !== false && transaction.attempts >= transaction.maxAttempts) {
    transaction.status = 'LOCKED';
  } else if (error) {
    transaction.status = 'FAILED';
  }
  transaction.error = error
    ? { message: error.message, at: new Date() }
    : undefined;
  await transaction.save();
}

async function markCompleted(transaction, metadata = {}) {
  transaction.status = 'COMPLETED';
  transaction.completedAt = new Date();
  transaction.metadata = { ...(transaction.metadata || {}), ...metadata };
  await transaction.save();
}

module.exports = {
  consentEvidence,
  createTransaction,
  getOwnedTransaction,
  assertResendAllowed,
  recordAttempt,
  markCompleted,
  sha256
};
