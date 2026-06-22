'use strict';

const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerSettlement = require('../models/PharmacyLedgerSettlement');
const PatientSettlementCredit = require('../models/PatientSettlementCredit');
const Pharmacy = require('../models/Pharmacy');
const {
  money,
  sum,
  buildFinalConcessionAllocations,
  buildRetroactiveAllocations,
  allocatePaymentMethodsToSales,
} = require('../utils/pharmacyLedgerSettlement.engine');

const PAYMENT_METHODS = new Set([
  'Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment',
]);
const ADVANCE_METHODS = new Set(['IPDAdvance', 'PharmacyAdvance']);

function objectId(value, name) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(`${name} is required and must be a valid ObjectId.`);
  }
  return new mongoose.Types.ObjectId(value);
}

function optionalObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : undefined;
}

function scoped(query, session) {
  return session ? query.session(session) : query;
}

function normalizePaymentSources(payments = []) {
  if (!Array.isArray(payments)) throw new Error('payments must be an array.');
  const normalized = payments
    .map((payment) => ({
      method: String(payment.method || '').trim(),
      amount: money(payment.amount),
      reference: String(payment.reference || '').trim(),
      walletType: payment.walletType || (payment.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : payment.method === 'IPDAdvance' ? 'IPD_SHARED' : null),
    }))
    .filter((payment) => payment.amount > 0);

  for (const payment of normalized) {
    if (!PAYMENT_METHODS.has(payment.method)) throw new Error(`Unsupported payment method: ${payment.method}.`);
  }
  return normalized;
}

function saleGross(sale) {
  return money(sale.gross_amount || sale.subtotal || sale.total_amount || 0);
}

function saleExistingDiscounts(sale) {
  // Original item/bill discounts plus previous final-settlement adjustments.
  return money(
    (sale.item_discount_amount || 0)
    + (sale.discount_amount || 0)
    + (sale.settlement_discount_amount || 0)
    + (sale.credit_note_amount || 0)
  );
}

function saleRow(sale) {
  return {
    saleId: String(sale._id),
    saleNumber: sale.sale_number,
    saleDate: sale.sale_date,
    openingDue: money(sale.balance_due),
    amountPaid: money(sale.amount_paid),
    grossAmount: saleGross(sale),
    existingDiscounts: saleExistingDiscounts(sale),
    sale,
  };
}

async function resolvePharmacyId(value, session) {
  if (value && mongoose.Types.ObjectId.isValid(value)) return new mongoose.Types.ObjectId(value);
  const pharmacy = await scoped(Pharmacy.findOne({ status: 'Active' }).select('_id'), session);
  return pharmacy?._id;
}

async function loadSelectedSales(input, session) {
  const admissionId = optionalObjectId(input.admissionId);
  const patientId = optionalObjectId(input.patientId);
  if (!admissionId && !patientId) throw new Error('admissionId or patientId is required.');

  const query = { status: { $ne: 'Cancelled' }, include_in_discharge_clearance: true };
  if (admissionId) query.admission_id = admissionId;
  if (patientId) query.patient_id = patientId;

  if (Array.isArray(input.saleIds) && input.saleIds.length > 0) {
    const ids = input.saleIds.map((value) => objectId(value, 'saleId'));
    query._id = { $in: ids };
  }

  const sales = await scoped(Sale.find(query).sort({ sale_date: 1 }), session);
  if (!sales.length) throw new Error('No eligible pharmacy sales were found for this ledger context.');

  // A supplied sale must belong to the requested patient/admission context.
  if (Array.isArray(input.saleIds) && sales.length !== input.saleIds.length) {
    throw new Error('One or more selected sales do not belong to this patient/admission ledger or are cancelled.');
  }
  return sales;
}

function calculateDiscountPool(rows, input) {
  const scope = input.discountScope || 'UNPAID_DUE';
  const type = input.discountType || 'PERCENTAGE';
  const treatment = input.percentageTreatment || 'ADDITIONAL';
  const value = money(input.discountValue);
  if (value < 0) throw new Error('Discount cannot be negative.');
  if (type === 'PERCENTAGE' && value > 100) throw new Error('Percentage discount cannot exceed 100%.');

  const outstanding = sum(rows, (row) => row.openingDue);
  const gross = sum(rows, (row) => row.grossAmount);
  const existingDiscounts = sum(rows, (row) => row.existingDiscounts);
  const net = sum(rows, (row) => money(row.sale.total_amount));

  let calculated = 0;
  if (type === 'FIXED') {
    calculated = value;
  } else if (scope === 'UNPAID_DUE') {
    // Current due already excludes all earlier bill/item discounts.
    calculated = money((outstanding * value) / 100);
  } else {
    const percentageOfGross = money((gross * value) / 100);
    calculated = treatment === 'TARGET_TOTAL_DISCOUNT'
      ? Math.max(0, money(percentageOfGross - existingDiscounts))
      : percentageOfGross;
  }

  return {
    outstanding,
    gross,
    net,
    existingDiscounts,
    calculated: money(calculated),
  };
}

function buildSettlementPreviewFromRows(rows, input) {
  const settlementType = input.settlementType || 'FINAL_CONCESSION';
  const discountScope = input.discountScope || 'UNPAID_DUE';
  const discountType = input.discountType || 'PERCENTAGE';
  const percentageTreatment = input.percentageTreatment || 'ADDITIONAL';
  const allocationPolicy = input.allocationPolicy || 'PROPORTIONAL';
  const totals = calculateDiscountPool(rows, { ...input, discountScope, discountType, percentageTreatment });
  const openRows = rows.filter((row) => row.openingDue > 0);

  let allocations;
  let discountUnapplied = 0;

  if (settlementType === 'FINAL_CONCESSION') {
    const discountToApply = Math.min(totals.calculated, totals.outstanding);
    discountUnapplied = money(totals.calculated - discountToApply);
    allocations = buildFinalConcessionAllocations(openRows, {
      discountToApply,
      allocationPolicy,
      manualAllocations: input.allocations,
    });
  } else if (settlementType === 'RETROACTIVE_INVOICE_DISCOUNT') {
    if (discountType === 'PERCENTAGE' && allocationPolicy === 'MANUAL') {
      throw new Error('Manual allocation is not available for a true retroactive percentage invoice discount; the percentage must be calculated per selected invoice.');
    }
    allocations = buildRetroactiveAllocations(rows, {
      discountType,
      discountValue: input.discountValue,
      percentageTreatment,
      allocationPolicy,
      manualAllocations: input.allocations,
    });
    discountUnapplied = sum(allocations, (allocation) => allocation.unapplied);
  } else {
    throw new Error('Unsupported settlementType.');
  }

  const paymentRequired = sum(allocations, (allocation) => allocation.paymentAllocated);
  const settlementDiscountApplied = sum(allocations, (allocation) => allocation.settlementDiscountAllocated);
  const patientCreditCreated = sum(allocations, (allocation) => allocation.creditNoteAllocated);
  const discountApplied = money(settlementDiscountApplied + patientCreditCreated);

  return {
    settlementType,
    discountScope,
    discountType,
    percentageTreatment,
    allocationPolicy,
    summary: {
      openingLedgerGross: totals.gross,
      openingLedgerNet: totals.net,
      openingOutstanding: totals.outstanding,
      openingPaid: sum(rows, (row) => row.amountPaid),
      existingDiscounts: totals.existingDiscounts,
      calculatedDiscount: totals.calculated,
      discountApplied,
      discountUnapplied,
      settlementDiscountApplied,
      patientCreditCreated,
      paymentRequired,
      selectedSales: rows.length,
      openSales: openRows.length,
    },
    allocations,
  };
}

async function previewLedgerSettlement(input, context = {}) {
  const session = context.session;
  const sales = await loadSelectedSales(input, session);
  const preview = buildSettlementPreviewFromRows(sales.map(saleRow), input);
  return {
    ...preview,
    sales: sales.map((sale) => ({
      _id: sale._id,
      sale_number: sale.sale_number,
      sale_date: sale.sale_date,
      total_amount: money(sale.total_amount),
      gross_amount: saleGross(sale),
      amount_paid: money(sale.amount_paid),
      balance_due: money(sale.balance_due),
      existing_discounts: saleExistingDiscounts(sale),
      payment_deferred: sale.payment_deferred,
    })),
  };
}

function requireReason(value) {
  const reason = String(value || '').trim();
  if (!reason) throw new Error('A settlement reason is required for audit purposes.');
  return reason;
}

async function getAdvanceBalance({ patientId, admissionId, walletType, session }) {
  const query = { walletType };
  if (admissionId) query.admissionId = admissionId;
  else query.patientId = patientId;
  const last = await scoped(PatientAdvanceLedger.findOne(query).sort({ createdAt: -1 }), session);
  return money(last?.balanceAfter);
}

async function debitAdvanceIfUsed({ payment, sale, settlement, session, createdBy }) {
  if (!ADVANCE_METHODS.has(payment.method)) return;
  if (!sale.patient_id || !sale.admission_id) {
    throw new Error(`${payment.method} can only be used for an admitted patient.`);
  }
  const walletType = payment.walletType || (payment.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED');
  const available = await getAdvanceBalance({ patientId: sale.patient_id, admissionId: sale.admission_id, walletType, session });
  if (available + 0.01 < payment.amount) {
    throw new Error(`Insufficient ${walletType} balance. Available ₹${available}, requested ₹${payment.amount}.`);
  }
  const balanceAfter = money(available - payment.amount);
  await PatientAdvanceLedger.create([{
    hospitalId: settlement.hospital_id,
    patientId: sale.patient_id,
    admissionId: sale.admission_id,
    walletType,
    transactionType: 'OUTSTANDING_SETTLEMENT_DEBIT',
    direction: 'DEBIT',
    amount: payment.amount,
    paymentMethod: payment.method,
    referenceNumber: settlement.settlement_number,
    documentType: 'Adjustment',
    documentId: settlement._id,
    sourceModule: 'Pharmacy',
    sourceId: sale._id,
    balanceAfter,
    notes: `Pharmacy ledger settlement ${settlement.settlement_number}`,
    createdBy,
  }], { session });
}

async function createPatientCredit({ settlement, amount, disposition, session, createdBy }) {
  if (amount <= 0) return null;
  if (!['PATIENT_CREDIT', 'REFUND_PENDING', 'PHARMACY_ADVANCE', 'IPD_ADJUSTMENT'].includes(disposition)) {
    throw new Error('A patientCreditDisposition is required when a retroactive discount creates credit on paid bills.');
  }

  const [credit] = await PatientSettlementCredit.create([{
    hospital_id: settlement.hospital_id,
    pharmacy_id: settlement.pharmacy_id,
    patient_id: settlement.patient_id,
    admission_id: settlement.admission_id,
    settlement_id: settlement._id,
    amount,
    disposition,
    reference_number: settlement.settlement_number,
    notes: `Credit created by pharmacy settlement ${settlement.settlement_number}`,
    created_by: createdBy,
  }], { session });

  if (disposition === 'PHARMACY_ADVANCE') {
    const walletType = 'PHARMACY_IPD';
    const opening = await getAdvanceBalance({
      patientId: settlement.patient_id,
      admissionId: settlement.admission_id,
      walletType,
      session,
    });
    const balanceAfter = money(opening + amount);
    await PatientAdvanceLedger.create([{
      hospitalId: settlement.hospital_id,
      patientId: settlement.patient_id,
      admissionId: settlement.admission_id,
      walletType,
      transactionType: 'PHARMACY_SETTLEMENT_CREDIT',
      direction: 'CREDIT',
      amount,
      paymentMethod: 'Adjustment',
      referenceNumber: settlement.settlement_number,
      documentType: 'Adjustment',
      documentId: settlement._id,
      sourceModule: 'Pharmacy',
      sourceId: settlement._id,
      balanceAfter,
      notes: `Retroactive pharmacy settlement credit ${settlement.settlement_number}`,
      createdBy,
    }], { session });
    await Patient.updateOne({ _id: settlement.patient_id }, { $inc: { pharmacy_advance_balance: amount } }, { session });
  }

  return credit;
}

function paymentReference(settlementNumber, sourceReference) {
  return `SETTLEMENT:${settlementNumber}${sourceReference ? `|${sourceReference}` : ''}`;
}

async function findLinkedBill(sale, session) {
  const conditions = [{ sale_id: sale._id }];
  if (sale.invoice_id) conditions.push({ invoice_id: sale.invoice_id });
  return scoped(Bill.findOne({ $or: conditions }), session);
}

async function findLinkedInvoice(sale, session) {
  const conditions = [{ sale_id: sale._id }];
  if (sale.invoice_id) conditions.unshift({ _id: sale.invoice_id });
  return scoped(Invoice.findOne({ $or: conditions }), session);
}

async function applyAllocation({ sale, allocation, paymentEntries, settlement, createdBy, session }) {
  const now = new Date();
  const paymentAllocated = money(allocation.paymentAllocated);
  const settlementDiscount = money(allocation.settlementDiscountAllocated);
  const creditNote = money(allocation.creditNoteAllocated);
  const closingDue = money(Math.max(0, allocation.openingDue - paymentAllocated - settlementDiscount));

  sale.amount_paid = money((sale.amount_paid || 0) + paymentAllocated);
  sale.settlement_discount_amount = money((sale.settlement_discount_amount || 0) + settlementDiscount);
  sale.credit_note_amount = money((sale.credit_note_amount || 0) + creditNote);
  sale.balance_due = closingDue;
  sale.status = closingDue <= 0 ? 'Completed' : 'Partially Paid';
  sale.payment_deferred = closingDue > 0;
  sale.settled_at = closingDue <= 0 ? now : sale.settled_at;
  sale.payment_method = paymentEntries.length > 1 ? 'Split' : (paymentEntries[0]?.method || sale.payment_method);
  sale.payments = sale.payments || [];
  sale.settlement_refs = sale.settlement_refs || [];
  for (const payment of paymentEntries) {
    sale.payments.push({
      method: payment.method,
      amount: payment.amount,
      reference: paymentReference(settlement.settlement_number, payment.reference),
      walletType: payment.walletType,
    });
  }
  sale.settlement_refs.push({
    settlement_id: settlement._id,
    payment_amount: paymentAllocated,
    settlement_discount_amount: settlementDiscount,
    credit_note_amount: creditNote,
    settled_at: now,
  });
  await sale.save({ session });

  const invoice = await findLinkedInvoice(sale, session);
  if (invoice) {
    invoice.amount_paid = money((invoice.amount_paid || 0) + paymentAllocated);
    invoice.settlement_discount_amount = money((invoice.settlement_discount_amount || 0) + settlementDiscount);
    invoice.credit_note_total = money((invoice.credit_note_total || 0) + creditNote);
    invoice.payment_history = invoice.payment_history || [];
    invoice.settlement_refs = invoice.settlement_refs || [];
    for (const payment of paymentEntries) {
      invoice.payment_history.push({
        amount: payment.amount,
        method: payment.method,
        reference: paymentReference(settlement.settlement_number, payment.reference),
        status: 'Completed',
        collected_by: createdBy,
      });
    }
    invoice.settlement_refs.push({
      settlement_id: settlement._id,
      payment_amount: paymentAllocated,
      settlement_discount_amount: settlementDiscount,
      credit_note_amount: creditNote,
      settled_at: now,
    });
    await invoice.save({ session });
  }

  const bill = await findLinkedBill(sale, session);
  if (bill) {
    bill.paid_amount = money((bill.paid_amount || 0) + paymentAllocated);
    bill.settlement_discount_amount = money((bill.settlement_discount_amount || 0) + settlementDiscount);
    bill.credit_note_amount = money((bill.credit_note_amount || 0) + creditNote);
    bill.payments = bill.payments || [];
    bill.settlement_refs = bill.settlement_refs || [];
    for (const payment of paymentEntries) {
      bill.payments.push({
        method: payment.method,
        amount: payment.amount,
        reference: paymentReference(settlement.settlement_number, payment.reference),
      });
    }
    bill.settlement_refs.push({
      settlement_id: settlement._id,
      payment_amount: paymentAllocated,
      settlement_discount_amount: settlementDiscount,
      credit_note_amount: creditNote,
      settled_at: now,
    });
    await bill.save({ session });
  }

  for (const payment of paymentEntries) {
    await debitAdvanceIfUsed({ payment, sale, settlement, session, createdBy });
    await PharmacyLedgerEntry.create([{
      hospitalId: settlement.hospital_id,
      pharmacyId: settlement.pharmacy_id,
      entryType: ADVANCE_METHODS.has(payment.method) ? 'ADVANCE_USED' : 'OUTSTANDING_PAYMENT',
      direction: ADVANCE_METHODS.has(payment.method) ? 'NON_CASH' : 'IN',
      amount: payment.amount,
      paymentMethod: payment.method,
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: invoice?._id,
      settlementId: settlement._id,
      settlementAllocationId: allocation._id,
      notes: `Payment allocated by settlement ${settlement.settlement_number}`,
      createdBy,
    }], { session });
  }

  if (settlementDiscount > 0) {
    await PharmacyLedgerEntry.create([{
      hospitalId: settlement.hospital_id,
      pharmacyId: settlement.pharmacy_id,
      entryType: 'DISCOUNT',
      direction: 'NON_CASH',
      amount: settlementDiscount,
      paymentMethod: 'BulkDiscount',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: invoice?._id,
      settlementId: settlement._id,
      settlementAllocationId: allocation._id,
      notes: `Final ledger settlement discount ${settlement.settlement_number}`,
      createdBy,
    }], { session });
  }

  if (creditNote > 0) {
    await PharmacyLedgerEntry.create([{
      hospitalId: settlement.hospital_id,
      pharmacyId: settlement.pharmacy_id,
      entryType: 'CREDIT_NOTE',
      direction: 'NON_CASH',
      amount: creditNote,
      paymentMethod: 'Adjustment',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: invoice?._id,
      settlementId: settlement._id,
      settlementAllocationId: allocation._id,
      notes: `Retroactive credit note from settlement ${settlement.settlement_number}`,
      createdBy,
    }], { session });
  }
}

async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function postLedgerSettlement(input, context = {}) {
  const createdBy = objectId(context.createdBy || input.createdBy, 'createdBy');
  const patientId = optionalObjectId(input.patientId);
  const admissionId = optionalObjectId(input.admissionId);
  const hospitalId = optionalObjectId(context.hospitalId || input.hospitalId);
  const pharmacyId = await resolvePharmacyId(context.pharmacyId || input.pharmacyId);
  const reason = requireReason(input.reason);
  const idempotencyKey = String(input.idempotencyKey || '').trim();

  if (idempotencyKey) {
    const existing = await PharmacyLedgerSettlement.findOne({ idempotency_key: idempotencyKey });
    if (existing) return { settlement: existing, replayed: true };
  }

  return runTransaction(async (session) => {
    if (idempotencyKey) {
      const existing = await scoped(PharmacyLedgerSettlement.findOne({ idempotency_key: idempotencyKey }), session);
      if (existing) return { settlement: existing, replayed: true };
    }

    const sales = await loadSelectedSales({ ...input, patientId, admissionId }, session);
    const preview = buildSettlementPreviewFromRows(sales.map(saleRow), input);
    const paymentSources = normalizePaymentSources(input.payments || []);
    const paymentReceived = sum(paymentSources, (payment) => payment.amount);
    if (Math.abs(paymentReceived - preview.summary.paymentRequired) > 0.01) {
      throw new Error(`Payment receipt total must equal ₹${preview.summary.paymentRequired}; received ₹${paymentReceived}.`);
    }
    if (preview.summary.patientCreditCreated > 0 && input.settlementType !== 'RETROACTIVE_INVOICE_DISCOUNT') {
      throw new Error('Patient credit can only be created by a retroactive invoice discount.');
    }

    const paymentMap = allocatePaymentMethodsToSales(paymentSources, preview.allocations);
    const allocationBySale = new Map(preview.allocations.map((allocation) => [String(allocation.saleId), allocation]));

    const resolvedPatientId = patientId || sales[0].patient_id;
    if (!resolvedPatientId) throw new Error('A patient is required for pharmacy ledger settlement.');
    const settlement = new PharmacyLedgerSettlement({
      hospital_id: hospitalId,
      pharmacy_id: pharmacyId,
      patient_id: resolvedPatientId,
      admission_id: admissionId || sales[0].admission_id,
      settlement_type: preview.settlementType,
      discount_scope: preview.discountScope,
      discount_type: preview.discountType,
      discount_value: money(input.discountValue),
      percentage_treatment: preview.percentageTreatment,
      allocation_policy: preview.allocationPolicy,
      opening_ledger_gross: preview.summary.openingLedgerGross,
      opening_ledger_net: preview.summary.openingLedgerNet,
      opening_paid_total: preview.summary.openingPaid,
      opening_outstanding_total: preview.summary.openingOutstanding,
      existing_discount_total: preview.summary.existingDiscounts,
      calculated_discount: preview.summary.calculatedDiscount,
      discount_applied: preview.summary.discountApplied,
      discount_unapplied: preview.summary.discountUnapplied,
      payment_received: paymentReceived,
      patient_credit_created: preview.summary.patientCreditCreated,
      patient_credit_disposition: preview.summary.patientCreditCreated > 0 ? input.patientCreditDisposition : 'NONE',
      payment_breakdown: paymentSources,
      allocations: sales
        .map((sale) => {
          const allocation = allocationBySale.get(String(sale._id));
          if (!allocation) return null;
          return {
            sale_id: sale._id,
            sale_number: sale.sale_number,
            bill_id: undefined,
            invoice_id: sale.invoice_id,
            opening_due: allocation.openingDue,
            opening_paid: allocation.amountPaid,
            gross_amount: allocation.grossAmount,
            existing_discounts: allocation.existingDiscounts,
            payment_allocated: allocation.paymentAllocated,
            settlement_discount_allocated: allocation.settlementDiscountAllocated,
            credit_note_allocated: allocation.creditNoteAllocated,
            unapplied_discount: allocation.unapplied || 0,
            closing_due: allocation.closingDue,
            payment_breakdown: paymentMap.get(String(sale._id)) || [],
          };
        })
        .filter(Boolean),
      reason,
      notes: String(input.notes || '').trim(),
      approved_by: optionalObjectId(input.approvedBy) || createdBy,
      created_by: createdBy,
      idempotency_key: idempotencyKey || undefined,
    });
    await settlement.save({ session });

    for (const sale of sales) {
      const allocation = allocationBySale.get(String(sale._id));
      if (!allocation) continue;
      const storedAllocation = settlement.allocations.find((entry) => String(entry.sale_id) === String(sale._id));
      await applyAllocation({
        sale,
        allocation: { ...allocation, _id: storedAllocation._id },
        paymentEntries: paymentMap.get(String(sale._id)) || [],
        settlement,
        createdBy,
        session,
      });
    }

    const credit = await createPatientCredit({
      settlement,
      amount: preview.summary.patientCreditCreated,
      disposition: input.patientCreditDisposition,
      session,
      createdBy,
    });
    if (credit) {
      settlement.patient_credit_id = credit._id;
      await settlement.save({ session });
    }

    // Only the portion that clears current unpaid sales reduces pharmacy outstanding.
    const clearedOutstanding = money(preview.summary.paymentRequired + preview.summary.settlementDiscountApplied);
    if (settlement.patient_id && clearedOutstanding > 0) {
      await Patient.updateOne(
        { _id: settlement.patient_id },
        { $inc: { pharmacy_outstanding_balance: -clearedOutstanding }, $set: { last_pharmacy_transaction: new Date() } },
        { session }
      );
    }

    return { settlement, replayed: false };
  });
}

async function getSettlementById(id) {
  return PharmacyLedgerSettlement.findById(objectId(id, 'settlementId'))
    .populate('patient_id', 'first_name last_name patientId uhid')
    .populate('admission_id', 'admissionNumber')
    .populate('created_by', 'name email')
    .populate('approved_by', 'name email')
    .populate('patient_credit_id');
}

async function listSettlements(filters = {}) {
  const query = {};
  if (filters.patientId) query.patient_id = objectId(filters.patientId, 'patientId');
  if (filters.admissionId) query.admission_id = objectId(filters.admissionId, 'admissionId');
  if (filters.status) query.status = filters.status;
  return PharmacyLedgerSettlement.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(filters.limit || 50), 200))
    .populate('patient_id', 'first_name last_name patientId uhid')
    .populate('admission_id', 'admissionNumber')
    .populate('created_by', 'name email');
}

async function reverseLedgerSettlement(id, input, context = {}) {
  const createdBy = objectId(context.createdBy || input.createdBy, 'createdBy');
  const reversalReason = requireReason(input.reason);

  return runTransaction(async (session) => {
    const settlement = await scoped(PharmacyLedgerSettlement.findById(objectId(id, 'settlementId')), session);
    if (!settlement) throw new Error('Settlement not found.');
    if (settlement.status !== 'POSTED') throw new Error('Only a posted settlement can be reversed.');

    for (const allocation of settlement.allocations) {
      const sale = await scoped(Sale.findById(allocation.sale_id), session);
      if (!sale) continue;
      const lastRef = (sale.settlement_refs || [])[sale.settlement_refs.length - 1];
      if (!lastRef || String(lastRef.settlement_id) !== String(settlement._id)) {
        throw new Error(`Settlement ${settlement.settlement_number} is not the latest settlement for sale ${sale.sale_number}; reverse later settlements first.`);
      }

      sale.amount_paid = money(Math.max(0, (sale.amount_paid || 0) - allocation.payment_allocated));
      sale.settlement_discount_amount = money(Math.max(0, (sale.settlement_discount_amount || 0) - allocation.settlement_discount_allocated));
      sale.credit_note_amount = money(Math.max(0, (sale.credit_note_amount || 0) - allocation.credit_note_allocated));
      sale.balance_due = money(allocation.opening_due);
      sale.status = sale.balance_due > 0 ? (sale.amount_paid > 0 ? 'Partially Paid' : 'Pending') : 'Completed';
      sale.payment_deferred = sale.balance_due > 0;
      sale.payments = (sale.payments || []).filter((payment) => !String(payment.reference || '').startsWith(`SETTLEMENT:${settlement.settlement_number}`));
      sale.settlement_refs.pop();
      await sale.save({ session });

      const invoice = await findLinkedInvoice(sale, session);
      if (invoice) {
        invoice.amount_paid = money(Math.max(0, (invoice.amount_paid || 0) - allocation.payment_allocated));
        invoice.settlement_discount_amount = money(Math.max(0, (invoice.settlement_discount_amount || 0) - allocation.settlement_discount_allocated));
        invoice.credit_note_total = money(Math.max(0, (invoice.credit_note_total || 0) - allocation.credit_note_allocated));
        invoice.payment_history = (invoice.payment_history || []).filter((payment) => !String(payment.reference || '').startsWith(`SETTLEMENT:${settlement.settlement_number}`));
        invoice.settlement_refs = (invoice.settlement_refs || []).filter((ref) => String(ref.settlement_id) !== String(settlement._id));
        await invoice.save({ session });
      }

      const bill = await findLinkedBill(sale, session);
      if (bill) {
        bill.paid_amount = money(Math.max(0, (bill.paid_amount || 0) - allocation.payment_allocated));
        bill.settlement_discount_amount = money(Math.max(0, (bill.settlement_discount_amount || 0) - allocation.settlement_discount_allocated));
        bill.credit_note_amount = money(Math.max(0, (bill.credit_note_amount || 0) - allocation.credit_note_allocated));
        bill.payments = (bill.payments || []).filter((payment) => !String(payment.reference || '').startsWith(`SETTLEMENT:${settlement.settlement_number}`));
        bill.settlement_refs = (bill.settlement_refs || []).filter((ref) => String(ref.settlement_id) !== String(settlement._id));
        await bill.save({ session });
      }

      if (allocation.payment_allocated > 0) {
        await PharmacyLedgerEntry.create([{
          hospitalId: settlement.hospital_id,
          pharmacyId: settlement.pharmacy_id,
          entryType: 'SETTLEMENT_REVERSAL',
          direction: 'OUT',
          amount: money(allocation.payment_allocated),
          paymentMethod: 'Adjustment',
          patientId: settlement.patient_id,
          admissionId: settlement.admission_id,
          saleId: sale._id,
          invoiceId: invoice?._id,
          settlementId: settlement._id,
          settlementAllocationId: allocation._id,
          notes: `Payment reversal of ${settlement.settlement_number}: ${reversalReason}`,
          createdBy,
        }], { session });
      }
      const nonCashReversal = money(allocation.settlement_discount_allocated + allocation.credit_note_allocated);
      if (nonCashReversal > 0) {
        await PharmacyLedgerEntry.create([{
          hospitalId: settlement.hospital_id,
          pharmacyId: settlement.pharmacy_id,
          entryType: 'SETTLEMENT_REVERSAL',
          direction: 'NON_CASH',
          amount: nonCashReversal,
          paymentMethod: 'Adjustment',
          patientId: settlement.patient_id,
          admissionId: settlement.admission_id,
          saleId: sale._id,
          invoiceId: invoice?._id,
          settlementId: settlement._id,
          settlementAllocationId: allocation._id,
          notes: `Discount/credit-note reversal of ${settlement.settlement_number}: ${reversalReason}`,
          createdBy,
        }], { session });
      }
    }

    if (settlement.patient_credit_id) {
      const credit = await scoped(PatientSettlementCredit.findById(settlement.patient_credit_id), session);
      if (credit && credit.status === 'OPEN') {
        credit.status = 'VOID';
        await credit.save({ session });
        if (credit.disposition === 'PHARMACY_ADVANCE') {
          const opening = await getAdvanceBalance({ patientId: settlement.patient_id, admissionId: settlement.admission_id, walletType: 'PHARMACY_IPD', session });
          await PatientAdvanceLedger.create([{
            hospitalId: settlement.hospital_id,
            patientId: settlement.patient_id,
            admissionId: settlement.admission_id,
            walletType: 'PHARMACY_IPD',
            transactionType: 'PHARMACY_SETTLEMENT_CREDIT',
            direction: 'DEBIT',
            amount: credit.amount,
            paymentMethod: 'Adjustment',
            referenceNumber: `REVERSAL:${settlement.settlement_number}`,
            documentType: 'Adjustment',
            documentId: settlement._id,
            sourceModule: 'Pharmacy',
            sourceId: settlement._id,
            balanceAfter: money(opening - credit.amount),
            notes: `Reversal of pharmacy settlement credit ${settlement.settlement_number}`,
            createdBy,
          }], { session });
          await Patient.updateOne({ _id: settlement.patient_id }, { $inc: { pharmacy_advance_balance: -credit.amount } }, { session });
        }
      }
    }

    const restoredOutstanding = sum(settlement.allocations, (allocation) => allocation.payment_allocated + allocation.settlement_discount_allocated);
    if (settlement.patient_id && restoredOutstanding > 0) {
      await Patient.updateOne({ _id: settlement.patient_id }, { $inc: { pharmacy_outstanding_balance: restoredOutstanding } }, { session });
    }

    settlement.status = 'REVERSED';
    settlement.reversed_at = new Date();
    settlement.reversed_by = createdBy;
    settlement.reversal_reason = reversalReason;
    await settlement.save({ session });
    return settlement;
  });
}

module.exports = {
  previewLedgerSettlement,
  postLedgerSettlement,
  getSettlementById,
  listSettlements,
  reverseLedgerSettlement,
};
