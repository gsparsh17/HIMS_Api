const { getSourceFinancialStatus, postSourceCharge } = require('./chargePosting.service');
const { reconcileOtReadiness } = require('./otReadiness.service');
const { financialCanProceed } = require('./otWorkflow.service');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function financialSummary(status = {}, otCase = {}) {
  const chargePatient = money(status.charge?.patientLiability);
  const chargeSponsor = money(status.charge?.sponsorLiability);
  const estimatedGross = money(chargePatient + chargeSponsor || otCase.total_cost || otCase.estimated_cost);
  return {
    clearanceState: status.clearanceState || otCase.financialClearanceState || 'PAYMENT_REQUIRED',
    selectedMode: status.selectedMode || otCase.selectedBillingMode || null,
    estimatedGross,
    patientLiability: chargePatient,
    sponsorLiability: chargeSponsor,
    requiredNow: money(status.requiredNow ?? otCase.requiredNowAmount),
    paidNow: money(status.paidNow ?? otCase.paidAmount),
    outstandingRequiredNow: money(status.outstandingRequiredNow),
    totalInvoiced: money(status.totalInvoiced),
    invoiceCount: Array.isArray(status.invoices) ? status.invoices.length : 0,
    invoiceIds: Array.isArray(status.invoices) ? status.invoices.map((row) => row._id) : [],
    chargeId: status.charge?._id || null,
    billingState: otCase.billingState,
    billingIntent: otCase.billingIntent,
    billingClosureStatus: otCase.billingClosureStatus,
    canProceed: financialCanProceed(status.clearanceState || otCase.financialClearanceState, otCase),
    policySnapshot: status.policySnapshot || otCase.financialPolicySnapshot || {}
  };
}

function projectCompatibilityFields(otCase, status) {
  const total = money(
    Number(status.charge?.patientLiability || 0) + Number(status.charge?.sponsorLiability || 0)
    || status.totalInvoiced
    || otCase.total_cost
  );
  otCase.is_billed = Boolean(status.charge || status.bill || status.invoices?.length);
  otCase.billId = status.bill?._id || otCase.billId;
  otCase.invoiceId = status.invoices?.[0]?._id || otCase.invoiceId;
  otCase.total_cost = total;
  if (!otCase.estimated_cost) otCase.estimated_cost = total;
  otCase.paidAmount = money(status.paidNow);
  otCase.dueAmount = money(Math.max(0, total - otCase.paidAmount));
  otCase.selectedBillingMode = status.selectedMode || otCase.selectedBillingMode;
  otCase.requiredNowAmount = money(status.requiredNow);
  otCase.financialClearanceState = status.clearanceState || 'PAYMENT_REQUIRED';
  otCase.financialPolicySnapshot = status.policySnapshot || otCase.financialPolicySnapshot || {};
  otCase.billingClosureStatus = ['CLEARED', 'POSTPAID_ALLOWED'].includes(otCase.financialClearanceState)
    ? 'Cleared'
    : (otCase.financialClearanceState === 'EXCEPTION_APPROVED' ? 'Exception Approved' : 'Pending');
}

async function refreshOTFinancialState({ otCase, user, userId = user?._id, session, syncReadiness = true }) {
  const status = await getSourceFinancialStatus({ sourceModule: 'OTRequest', sourceId: otCase._id, user, session });
  projectCompatibilityFields(otCase, status);

  let readiness = null;
  if (syncReadiness) {
    readiness = await reconcileOtReadiness({ otCase, userId, session, autoApprove: true, saveCase: false });
  }
  await otCase.save(session ? { session } : undefined);
  return { status, readiness, summary: financialSummary(status, otCase), otCase };
}

async function ensureOTFinancialObligation({ otCase, user, selectedMode, requestedDeposit, adjustments = {}, overrideReason, session }) {
  const posted = await postSourceCharge({
    sourceModule: 'OTRequest',
    sourceId: otCase._id,
    selectedMode,
    requestedDeposit,
    adjustments,
    overrideReason,
    idempotencyKey: `OTRequest:${otCase._id}:charge`,
    user,
    session
  });
  const refreshed = await refreshOTFinancialState({ otCase, user, session, syncReadiness: true });
  return { posted, ...refreshed };
}

module.exports = {
  financialSummary,
  projectCompatibilityFields,
  refreshOTFinancialState,
  ensureOTFinancialObligation
};
