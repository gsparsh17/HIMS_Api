'use strict';

const NabhSetting = require('../models/NabhSetting');

const CLEARANCE_STAGES = Object.freeze([
  'PHARMACY_CLEARANCE',
  'IPD_FINAL_INVOICE',
  'IPD_FINANCIAL_CLEARANCE',
  'FINAL_DISCHARGE'
]);

const DEFAULT_IPD_WORKFLOW_POLICY = Object.freeze({
  pendingInvestigations: {
    blockLab: true,
    blockRadiology: true,
    allowAuthorisedException: true
  },
  requireMedicationCompletion: true,
  requireSummaryFinalized: true,
  requireStaffCompletedSummary: true,
  requirePharmacyClearance: true,
  autoExemptPharmacyWhenNoTransactions: true,
  requireFinalIPDInvoice: true,
  requireAdvanceReconciliation: true,
  requireFinancialClearance: true,
  unusedIpdAdvanceDisposition: 'REQUIRE_DECISION',
  clearanceOrder: [...CLEARANCE_STAGES],
  doctorRoundCharging: {
    mode: 'AUTO_PER_ROUND'
  },
  recurringCharges: {
    bed: true,
    nursing: true,
    rmoDutyDoctor: true
  }
});

function normalizedClearanceOrder(value) {
  const rows = Array.isArray(value) ? value.filter((stage) => CLEARANCE_STAGES.includes(stage)) : [];
  const unique = [...new Set(rows)];
  for (const stage of CLEARANCE_STAGES) {
    if (!unique.includes(stage)) unique.push(stage);
  }
  // Final discharge is always the terminal state even when the UI order is edited.
  return [...unique.filter((stage) => stage !== 'FINAL_DISCHARGE'), 'FINAL_DISCHARGE'];
}

function normalizePolicy(raw = {}) {
  const defaults = DEFAULT_IPD_WORKFLOW_POLICY;
  const roundMode = ['AUTO_PER_ROUND', 'ONCE_PER_DAY', 'MANUAL', 'DISABLED'].includes(raw.doctorRoundCharging?.mode)
    ? raw.doctorRoundCharging.mode
    : defaults.doctorRoundCharging.mode;
  const unusedAdvance = ['REQUIRE_DECISION', 'REQUIRE_REFUND', 'ALLOW_RETAIN'].includes(raw.unusedIpdAdvanceDisposition)
    ? raw.unusedIpdAdvanceDisposition
    : defaults.unusedIpdAdvanceDisposition;

  return {
    pendingInvestigations: {
      blockLab: raw.pendingInvestigations?.blockLab !== false,
      blockRadiology: raw.pendingInvestigations?.blockRadiology !== false,
      allowAuthorisedException: raw.pendingInvestigations?.allowAuthorisedException !== false
    },
    requireMedicationCompletion: raw.requireMedicationCompletion !== false,
    requireSummaryFinalized: raw.requireSummaryFinalized !== false,
    requireStaffCompletedSummary: raw.requireStaffCompletedSummary !== false,
    requirePharmacyClearance: raw.requirePharmacyClearance !== false,
    autoExemptPharmacyWhenNoTransactions: raw.autoExemptPharmacyWhenNoTransactions !== false,
    requireFinalIPDInvoice: raw.requireFinalIPDInvoice !== false,
    requireAdvanceReconciliation: raw.requireAdvanceReconciliation !== false,
    requireFinancialClearance: raw.requireFinancialClearance !== false,
    unusedIpdAdvanceDisposition: unusedAdvance,
    clearanceOrder: normalizedClearanceOrder(raw.clearanceOrder),
    doctorRoundCharging: { mode: roundMode },
    recurringCharges: {
      bed: raw.recurringCharges?.bed !== false,
      nursing: raw.recurringCharges?.nursing !== false,
      rmoDutyDoctor: raw.recurringCharges?.rmoDutyDoctor !== false
    }
  };
}

async function loadIPDWorkflowPolicy(hospitalId) {
  if (!hospitalId) return normalizePolicy({});
  const row = await NabhSetting.findOne({ hospitalId }).select('dischargePolicy').lean();
  return normalizePolicy(row?.dischargePolicy || {});
}

function stageBefore(policy, first, second) {
  const order = normalizedClearanceOrder(policy?.clearanceOrder);
  return order.indexOf(first) < order.indexOf(second);
}

module.exports = {
  CLEARANCE_STAGES,
  DEFAULT_IPD_WORKFLOW_POLICY,
  normalizePolicy,
  loadIPDWorkflowPolicy,
  stageBefore
};
