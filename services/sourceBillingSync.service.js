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

async function appendBillingLink({ sourceModule, sourceId, chargeId, billId, invoiceId, state, action, actorId, reason, session }) {
  const Model = MODEL_BY_MODULE[sourceModule];
  if (!Model || !sourceId || !mongoose.isValidObjectId(sourceId)) return null;
  const request = await Model.findById(sourceId, null, sessionOptions(session));
  if (!request) return null;
  request.chargeIds = uniqueIds([...(request.chargeIds || []), chargeId]);
  request.billIds = uniqueIds([...(request.billIds || []), billId]);
  request.invoiceIds = uniqueIds([...(request.invoiceIds || []), invoiceId]);
  if (state) request.billingState = state;
  request.is_billed = [BILLING_STATES.INVOICED, BILLING_STATES.PARTIALLY_INVOICED].includes(request.billingState);
  request.invoiceId = invoiceId || request.invoiceId;
  request.billingHistory = [...(request.billingHistory || []), {
    from: request.billingState,
    to: state || request.billingState,
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
    chargeId: charge._id,
    state: BILLING_STATES.CHARGE_POSTED,
    action: 'CHARGE_POSTED', actorId, session
  });
}

async function syncChargesInvoiced(charges, bill, invoice, actorId, session) {
  for (const charge of charges) {
    await appendBillingLink({ sourceModule: charge.sourceModule, sourceId: charge.sourceId,
      chargeId: charge._id, billId: bill._id, invoiceId: invoice._id,
      state: BILLING_STATES.INVOICED, action: 'INVOICE_ISSUED', actorId, session });
  }
}

module.exports = { appendBillingLink, syncChargePosted, syncChargesInvoiced };
