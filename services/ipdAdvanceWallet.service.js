'use strict';

const IPDAdmission = require('../models/IPDAdmission');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function getIpdSharedAdvanceBalance({ hospitalId, admissionId, session, fallbackBalance = 0 } = {}) {
  if (!admissionId) return money(fallbackBalance);
  const filter = {
    admissionId,
    walletType: 'IPD_SHARED',
    status: 'POSTED'
  };
  if (hospitalId) filter.hospitalId = hospitalId;

  const latest = await withSession(
    PatientAdvanceLedger.findOne(filter)
      .sort({ postedAt: -1, createdAt: -1, _id: -1 })
      .select('balanceAfter'),
    session
  ).lean();

  return latest ? money(latest.balanceAfter) : money(fallbackBalance);
}

async function syncIpdAdvanceProjection({ hospitalId, admissionId, balance, utilizedDelta = 0, session } = {}) {
  if (!admissionId) throw new Error('admissionId is required to sync IPD advance');
  const filter = { _id: admissionId };
  if (hospitalId) filter.hospitalId = hospitalId;
  const update = {
    $set: { advanceAmount: Math.max(0, money(balance)) }
  };
  if (money(utilizedDelta) > 0) {
    update.$inc = { advanceUtilizedAmount: money(utilizedDelta) };
  }

  const admission = await IPDAdmission.findOneAndUpdate(
    filter,
    update,
    { new: true, ...(session ? { session } : {}) }
  );
  if (!admission) {
    const error = new Error('IPD admission was not available while updating advance wallet');
    error.statusCode = 409;
    throw error;
  }
  return admission;
}

/**
 * Debit the authoritative IPD_SHARED wallet and keep IPDAdmission.advanceAmount
 * as a projection only. Updating the admission inside the same MongoDB
 * transaction also provides a write-conflict serialization point for concurrent
 * wallet consumers (billing/pharmacy).
 */
async function debitIpdSharedAdvance({
  hospitalId,
  patientId,
  admissionId,
  amount,
  transactionType,
  paymentMethod = 'IPDAdvance',
  referenceNumber,
  documentType = 'Adjustment',
  documentId,
  sourceModule = 'IPD',
  sourceId,
  notes,
  createdBy,
  idempotencyKey,
  utilizedDelta = 0,
  session,
  fallbackBalance = 0
} = {}) {
  const debit = money(amount);
  if (debit <= 0) {
    const error = new Error('Advance debit amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }
  if (!admissionId || !patientId) {
    const error = new Error('patientId and admissionId are required for IPD advance utilisation');
    error.statusCode = 400;
    throw error;
  }

  const openingBalance = await getIpdSharedAdvanceBalance({
    hospitalId,
    admissionId,
    session,
    fallbackBalance
  });
  if (openingBalance + 0.01 < debit) {
    const error = new Error(`Insufficient available IPD advance. Available ₹${openingBalance.toFixed(2)}`);
    error.statusCode = 409;
    error.code = 'INSUFFICIENT_IPD_ADVANCE';
    throw error;
  }

  const balanceAfter = money(openingBalance - debit);
  const admission = await syncIpdAdvanceProjection({
    hospitalId,
    admissionId,
    balance: balanceAfter,
    utilizedDelta,
    session
  });

  const [ledgerEntry] = await PatientAdvanceLedger.create([{
    hospitalId: hospitalId || admission.hospitalId,
    patientId,
    admissionId,
    walletType: 'IPD_SHARED',
    transactionType,
    direction: 'DEBIT',
    amount: debit,
    openingBalance,
    paymentMethod,
    referenceNumber,
    documentType,
    documentId,
    sourceModule,
    sourceId,
    balanceAfter,
    notes,
    createdBy,
    idempotencyKey
  }], session ? { session } : undefined);

  return { openingBalance, balanceAfter, ledgerEntry, admission };
}

module.exports = {
  getIpdSharedAdvanceBalance,
  syncIpdAdvanceProjection,
  debitIpdSharedAdvance
};
