'use strict';

// The canonical IPD finance service deliberately keeps rich Mongoose/print
// snapshots for auditability. The interactive Billing workspace does not need
// those deep snapshots on every refresh. These projections keep the fields the
// React workspace consumes while leaving full invoice/receipt print data on the
// dedicated print endpoints.

function plain(value) {
  if (!value) return value;
  return typeof value.toObject === 'function' ? value.toObject() : value;
}

function compactPricingSnapshot(snapshot) {
  if (!snapshot) return undefined;
  const value = plain(snapshot) || {};
  return {
    resultType: value.resultType,
    serviceCode: value.serviceCode,
    amounts: value.amounts ? {
      hospitalStandard: value.amounts.hospitalStandard,
      contracted: value.amounts.contracted,
      eligible: value.amounts.eligible,
      sponsorLiability: value.amounts.sponsorLiability,
      patientLiability: value.amounts.patientLiability,
      nonAdmissible: value.amounts.nonAdmissible,
      hospitalAdjustment: value.amounts.hospitalAdjustment,
      hospitalConcession: value.amounts.hospitalConcession,
      packageAbsorbed: value.amounts.packageAbsorbed
    } : undefined
  };
}

function compactCharge(row) {
  const value = plain(row) || {};
  return {
    _id: value._id,
    chargeType: value.chargeType,
    description: value.description,
    quantity: value.quantity,
    rate: value.rate,
    grossAmount: value.grossAmount,
    amount: value.amount,
    discount: value.discount,
    discountAmount: value.discountAmount,
    tax: value.tax,
    taxAmount: value.taxAmount,
    netAmount: value.netAmount,
    sourceModule: value.sourceModule,
    sourceId: value.sourceId,
    chargeDate: value.chargeDate,
    chargeDateKey: value.chargeDateKey,
    status: value.status,
    isBilled: value.isBilled,
    invoiceId: value.invoiceId,
    billId: value.billId,
    billedAt: value.billedAt,
    standardAmount: value.standardAmount,
    contractedAmount: value.contractedAmount,
    eligibleAmount: value.eligibleAmount,
    patientLiability: value.patientLiability,
    sponsorLiability: value.sponsorLiability,
    reversalReason: value.reversalReason,
    pricingSnapshot: compactPricingSnapshot(value.pricingSnapshot)
  };
}

function compactInvoice(row) {
  const value = plain(row) || {};
  const payer = plain(value.payer_allocation) || undefined;
  return {
    _id: value._id,
    invoice_number: value.invoice_number,
    admission_id: value.admission_id,
    bill_id: value.bill_id,
    invoice_type: value.invoice_type,
    document_stage: value.document_stage,
    is_final_ipd_invoice: value.is_final_ipd_invoice,
    issued_at: value.issued_at,
    issue_date: value.issue_date,
    due_date: value.due_date,
    createdAt: value.createdAt,
    created_at: value.created_at,
    subtotal: value.subtotal,
    total: value.total,
    gross_amount: value.gross_amount,
    amount_paid: value.amount_paid,
    balance_due: value.balance_due,
    status: value.status,
    advance_applied: value.advance_applied,
    credit_authorised_amount: value.credit_authorised_amount,
    credit_status: value.credit_status,
    credit_note_total: value.credit_note_total,
    settlement_discount_amount: value.settlement_discount_amount,
    refunded_amount: value.refunded_amount,
    receipt_numbers: value.receipt_numbers,
    collection_mode: value.collection_mode,
    collection_owner: value.collection_owner,
    collection_transferred_to_ipd: value.collection_transferred_to_ipd,
    collection_transferred_amount: value.collection_transferred_amount,
    payer_allocation: payer ? {
      coverage_id: payer.coverage_id,
      payer_id: payer.payer_id,
      standard_amount: payer.standard_amount,
      contracted_amount: payer.contracted_amount,
      eligible_amount: payer.eligible_amount,
      patient_liability: payer.patient_liability,
      sponsor_liability: payer.sponsor_liability,
      non_admissible_amount: payer.non_admissible_amount,
      sponsor_paid_amount: payer.sponsor_paid_amount
    } : undefined
  };
}

function compactTransaction(row) {
  const value = plain(row) || {};
  return {
    _id: value._id,
    billId: value.billId,
    invoiceId: value.invoiceId,
    transactionNumber: value.transactionNumber,
    transactionType: value.transactionType,
    direction: value.direction,
    amount: value.amount,
    externalMoneyMovement: value.externalMoneyMovement,
    cashFlowClass: value.cashFlowClass,
    amountTendered: value.amountTendered,
    amountApplied: value.amountApplied,
    changeReturned: value.changeReturned,
    advanceCreated: value.advanceCreated,
    paymentMethod: value.paymentMethod,
    paymentReference: value.paymentReference,
    receiptType: value.receiptType,
    amountBeforeSettlement: value.amountBeforeSettlement,
    settlementDiscountAmount: value.settlementDiscountAmount,
    settlementDiscountReason: value.settlementDiscountReason,
    taxAdjustmentAmount: value.taxAdjustmentAmount,
    advanceApplied: value.advanceApplied,
    amountReceived: value.amountReceived,
    balanceAfter: value.balanceAfter,
    paymentBreakdown: value.paymentBreakdown,
    sourceModule: value.sourceModule,
    sourceId: value.sourceId,
    status: value.status,
    remarks: value.remarks,
    documentAllocations: value.documentAllocations,
    metadata: value.metadata,
    postedAt: value.postedAt,
    createdAt: value.createdAt
  };
}

function compactRunningBill(runningBill = {}) {
  const invoices = (runningBill.invoices || []).map(compactInvoice);
  const pharmacyInvoices = (runningBill.pharmacyInvoices || []).map(compactInvoice);
  return {
    success: runningBill.success,
    admission: runningBill.admission,
    patient: runningBill.patient,
    unbilledCharges: (runningBill.unbilledCharges || []).map(compactCharge),
    unbilledSummary: runningBill.unbilledSummary,
    billedCharges: (runningBill.billedCharges || []).map(compactCharge),
    pharmacyMirrorCharges: (runningBill.pharmacyMirrorCharges || []).map(compactCharge),
    invoices,
    pharmacyInvoices,
    // Workspace consumers derive allInvoices from invoices + pharmacyInvoices.
    // Receipt activity is already present once in ledger.transactions.
    pendingDiscountApprovals: runningBill.pendingDiscountApprovals || [],
    financialSummary: runningBill.financialSummary
  };
}

function compactLedger(ledger = {}) {
  return {
    success: ledger.success,
    totals: ledger.totals,
    transactions: (ledger.transactions || []).map(compactTransaction),
    entries: ledger.entries || []
  };
}

function compactClearance(clearance = {}) {
  return {
    success: clearance.success,
    ready: clearance.ready,
    cleared: clearance.cleared,
    explicitClearanceStatus: clearance.explicitClearanceStatus,
    checks: clearance.checks,
    workflowPolicy: clearance.workflowPolicy,
    pharmacyBillingPolicy: clearance.pharmacyBillingPolicy,
    pharmacyMustPrecedeFinance: clearance.pharmacyMustPrecedeFinance,
    pharmacyAutoExemptEligible: clearance.pharmacyAutoExemptEligible,
    summary: clearance.summary,
    pendingPharmacySales: clearance.pendingPharmacySales || []
  };
}

function compactFinanceWorkspacePayload({ runningBill, ledger, clearance }) {
  return {
    success: true,
    compact: true,
    workspaceVersion: 2,
    runningBill: compactRunningBill(runningBill),
    ledger: compactLedger(ledger),
    clearance: compactClearance(clearance)
  };
}

module.exports = {
  compactCharge,
  compactInvoice,
  compactTransaction,
  compactRunningBill,
  compactLedger,
  compactClearance,
  compactFinanceWorkspacePayload
};
