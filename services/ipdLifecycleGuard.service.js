'use strict';

const { operationNow } = require('../utils/operationTimeContext');
const IPDAdmission = require('../models/IPDAdmission');

const CLOSED_ADMISSION_STATUSES = new Set(['Discharged', 'Cancelled', 'LAMA', 'DAMA', 'Expired']);

function lifecycleError(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  // Controllers in this repository use both `status` and `statusCode` for
  // domain errors. Set both so the lifecycle guard never degrades a 4xx
  // conflict/forbidden response into a generic 500.
  error.status = statusCode;
  return error;
}

function isChargeFrozen(admission) {
  return String(admission?.chargeFreeze?.status || 'open') === 'frozen';
}

function assertAdmissionOpenForMutation(admission, { action = 'Clinical activity', allowFrozen = false } = {}) {
  if (!admission) throw lifecycleError('IPD admission not found', 'IPD_ADMISSION_NOT_FOUND', 404);
  if (CLOSED_ADMISSION_STATUSES.has(String(admission.status || '')) || admission.finalDischargedAt) {
    throw lifecycleError(`${action} is blocked because this IPD admission is finally closed.`, 'IPD_ADMISSION_CLOSED');
  }
  if (!allowFrozen && isChargeFrozen(admission)) {
    throw lifecycleError(`${action} is blocked because IPD charges are frozen for final billing. Reopen the charge freeze through the authorised discharge workflow first.`, 'IPD_CHARGE_FREEZE_ACTIVE');
  }
  return admission;
}

async function reopenChargeFreeze({ admission, user, reason, session = null }) {
  if (!admission) throw lifecycleError('IPD admission not found', 'IPD_ADMISSION_NOT_FOUND', 404);
  if (!isChargeFrozen(admission)) return admission;
  const text = String(reason || '').trim();
  if (!text) throw lifecycleError('A reason is required to reopen the IPD charge freeze', 'CHARGE_REOPEN_REASON_REQUIRED', 400);
  admission.chargeFreeze = {
    ...(admission.chargeFreeze?.toObject?.() || admission.chargeFreeze || {}),
    status: 'open',
    reopenedAt: operationNow(),
    reopenedBy: user?._id,
    reopenReason: text,
    reopenCount: Number(admission.chargeFreeze?.reopenCount || 0) + 1
  };
  admission.financialClearanceStatus = 'in_progress';
  admission.financialClearedAt = undefined;
  admission.financialClearedBy = undefined;
  admission.finalSettlementReceiptNumber = undefined;
  await admission.save(session ? { session } : undefined);
  return admission;
}

async function invalidateClearanceForMutation({ admissionId, hospitalId, session = null }) {
  const options = session ? { session } : undefined;
  await IPDAdmission.updateOne(
    { _id: admissionId, hospitalId },
    {
      $set: { financialClearanceStatus: 'in_progress' },
      $unset: { financialClearedAt: 1, financialClearedBy: 1, finalSettlementReceiptNumber: 1 }
    },
    options
  );
}

module.exports = {
  CLOSED_ADMISSION_STATUSES,
  isChargeFrozen,
  assertAdmissionOpenForMutation,
  reopenChargeFreeze,
  invalidateClearanceForMutation
};
