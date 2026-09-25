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

// A configured order that omits PHARMACY_CLEARANCE is the admin-selected
// "no pharmacy" workflow for hospitals without an in-house pharmacy.
function isNoPharmacyOrder(value) {
  const rows = Array.isArray(value) ? value.filter((stage) => CLEARANCE_STAGES.includes(stage)) : [];
  return rows.length > 0 && !rows.includes('PHARMACY_CLEARANCE');
}

function normalizedClearanceOrder(value) {
  const rows = Array.isArray(value) ? value.filter((stage) => CLEARANCE_STAGES.includes(stage)) : [];
  const unique = [...new Set(rows)];
  const noPharmacy = isNoPharmacyOrder(value);
  for (const stage of CLEARANCE_STAGES) {
    if (noPharmacy && stage === 'PHARMACY_CLEARANCE') continue;
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
    requirePharmacyClearance: raw.requirePharmacyClearance !== false && !isNoPharmacyOrder(raw.clearanceOrder),
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
  // A stage absent from the order (e.g. Pharmacy in the no-pharmacy workflow)
  // is never "before" or "after" anything.
  if (!order.includes(first) || !order.includes(second)) return false;
  return order.indexOf(first) < order.indexOf(second);
}

// Returns the first IPD stage that the admin-configured order places before
// Pharmacy Final Clearance but which is not complete yet, or null. The reverse
// direction (Pharmacy before invoice/finance) is enforced in ipdFinancial.
function pharmacyClearanceOrderBlocker(policy, { finalInvoiceIssued, financialClearanceStatus } = {}) {
  if (!policy?.requirePharmacyClearance) return null;
  if (
    policy.requireFinalIPDInvoice &&
    stageBefore(policy, 'IPD_FINAL_INVOICE', 'PHARMACY_CLEARANCE') &&
    !finalInvoiceIssued
  ) {
    return {
      stage: 'IPD_FINAL_INVOICE',
      code: 'FINAL_IPD_INVOICE_REQUIRED_BEFORE_PHARMACY_CLEARANCE',
      message: 'Hospital clearance order requires the Final IPD invoice before Pharmacy Final Clearance'
    };
  }
  if (
    policy.requireFinancialClearance &&
    stageBefore(policy, 'IPD_FINANCIAL_CLEARANCE', 'PHARMACY_CLEARANCE') &&
    !['cleared', 'exception_approved'].includes(String(financialClearanceStatus || ''))
  ) {
    return {
      stage: 'IPD_FINANCIAL_CLEARANCE',
      code: 'IPD_FINANCIAL_CLEARANCE_REQUIRED_BEFORE_PHARMACY_CLEARANCE',
      message: 'Hospital clearance order requires IPD Finance Clearance before Pharmacy Final Clearance'
    };
  }
  return null;
}

module.exports = {
  CLEARANCE_STAGES,
  DEFAULT_IPD_WORKFLOW_POLICY,
  normalizePolicy,
  loadIPDWorkflowPolicy,
  stageBefore,
  isNoPharmacyOrder,
  pharmacyClearanceOrderBlocker
};
