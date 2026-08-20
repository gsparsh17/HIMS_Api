const mongoose = require('mongoose');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const { BILLING_STATES } = require('../utils/billingLifecycle');

const MODEL_BY_MODULE = {
  LabRequest,
  Lab: LabRequest,
  RadiologyRequest,
  Radiology: RadiologyRequest,
  ProcedureRequest,
  Procedure: ProcedureRequest
};

function sessionOptions(session) { return session ? { session } : {}; }
function uniqueIds(values = []) { return [...new Set(values.filter(Boolean).map(String))]; }

async function appendBillingLink({ sourceModule, sourceId, hospitalId, chargeId, billId, invoiceId, state, action, actorId, reason, billingIntent, selectedBillingMode, requiredNowAmount, financialClearanceState, financialPolicySnapshot, pricingSnapshot, session }) {
  const Model = MODEL_BY_MODULE[sourceModule];
  if (!Model || !sourceId || !mongoose.isValidObjectId(sourceId)) return null;
  if (!hospitalId) return null;
  const request = await Model.findOne({ _id: sourceId, hospitalId }, null, sessionOptions(session));
  if (!request) return null;
  const previousState = request.billingState;
  request.chargeIds = uniqueIds([...(request.chargeIds || []), chargeId]);
  request.billIds = uniqueIds([...(request.billIds || []), billId]);
  request.invoiceIds = uniqueIds([...(request.invoiceIds || []), invoiceId]);
  if (state) request.billingState = state;
  if (billingIntent) request.billingIntent = billingIntent;
  if (selectedBillingMode) request.selectedBillingMode = selectedBillingMode;
  if (requiredNowAmount !== undefined && requiredNowAmount !== null) request.requiredNowAmount = Number(requiredNowAmount || 0);
  if (financialClearanceState) request.financialClearanceState = financialClearanceState;
  if (financialPolicySnapshot && typeof financialPolicySnapshot === 'object') request.financialPolicySnapshot = financialPolicySnapshot;
  if (pricingSnapshot && typeof pricingSnapshot === 'object') request.pricingSnapshot = pricingSnapshot;
  request.is_billed = [BILLING_STATES.INVOICED, BILLING_STATES.PARTIALLY_INVOICED].includes(request.billingState);
  request.invoiceId = invoiceId || request.invoiceId;
  request.billingHistory = [...(request.billingHistory || []), {
    from: previousState,
    to: state || previousState,
    action: action || 'LINK_FINANCIAL_DOCUMENT',
    documentId: invoiceId || billId || chargeId,
    at: new Date(), by: actorId, reason
  }];
  await request.save(sessionOptions(session));
  return request;
}

async function syncChargePosted(charge, actorId, session) {
  return appendBillingLink({
    sourceModule: charge.sourceModule,
    sourceId: charge.sourceId,
    hospitalId: charge.hospitalId,
    chargeId: charge._id,
    state: BILLING_STATES.CHARGE_POSTED,
    action: 'CHARGE_POSTED', actorId,
    billingIntent: charge.selectedBillingMode === 'POSTPAID' || charge.selectedBillingMode === 'TPA_SPONSOR' || charge.selectedBillingMode === 'AUTHORIZED_EXCEPTION' ? 'DEFER_TO_ENCOUNTER' : 'BILL_NOW',
    selectedBillingMode: charge.selectedBillingMode,
    requiredNowAmount: charge.requiredNowAmount,
    financialClearanceState: charge.clearanceState,
    financialPolicySnapshot: charge.financialPolicySnapshot,
    pricingSnapshot: charge.pricingSnapshot,
    session
  });
}

async function syncChargesInvoiced(charges, bill, invoice, actorId, session) {
  for (const charge of charges) {
    await appendBillingLink({ sourceModule: charge.sourceModule, sourceId: charge.sourceId, hospitalId: charge.hospitalId,
      chargeId: charge._id, billId: bill._id, invoiceId: invoice._id,
      state: BILLING_STATES.INVOICED, action: 'INVOICE_ISSUED', actorId,
      billingIntent: charge.selectedBillingMode === 'POSTPAID' || charge.selectedBillingMode === 'TPA_SPONSOR' || charge.selectedBillingMode === 'AUTHORIZED_EXCEPTION' ? 'DEFER_TO_ENCOUNTER' : 'BILL_NOW',
      selectedBillingMode: charge.selectedBillingMode, requiredNowAmount: charge.requiredNowAmount,
      financialClearanceState: charge.clearanceState, financialPolicySnapshot: charge.financialPolicySnapshot,
      pricingSnapshot: charge.pricingSnapshot, session });
  }
}

module.exports = { appendBillingLink, syncChargePosted, syncChargesInvoiced };
