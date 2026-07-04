'use strict';

/**
 * Authoritative pharmacy return / final-clearance rules.
 *
 * The important invariant is intentionally simple:
 *   return value = reduction of the original sale's unpaid due
 *                + refundable paid residual.
 *
 * A patient who has paid nothing has no refundable residual. A return against
 * a fully deferred bill can therefore never create an IPD/Pharmacy advance.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const PharmacyReturn = require('../models/PharmacyReturn');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const PharmacyLedgerSettlement = require('../models/PharmacyLedgerSettlement');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const IPDAdmission = require('../models/IPDAdmission');
const MedicineBatch = require('../models/MedicineBatch');
const InventoryLedger = require('../models/InventoryLedger');
const {
  createAdvanceLedgerEntry,
  getAdvanceBalance,
} = require('./pharmacyTransaction.service');
const { MONEY_EPSILON, money, nonNegativeMoney, currentSaleNet, calculateReturnAllocation, calculateFinalClearanceAmounts } = require('./pharmacyReturnClearance.math');

const REFUND_METHODS = new Set(['Cash', 'UPI', 'Card', 'Bank', 'Net Banking', 'IPDAdvance', 'PharmacyAdvance']);
const CASH_REFUND_METHODS = new Set(['Cash', 'UPI', 'Card', 'Bank', 'Net Banking']);
const CLEARANCE_PAYMENT_METHODS = new Set(['Cash', 'UPI', 'Card', 'Bank', 'Net Banking', 'Insurance', 'Government Scheme']);
const CLEARANCE_ADVANCE_METHODS = new Set(['PharmacyAdvance', 'IPDAdvance']);

function newBusinessGroup(seed) {
  return String(seed || crypto.randomUUID());
}

function asObjectId(value, name) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    const error = new Error(`${name} is required and must be a valid ObjectId.`);
    error.status = 400;
    throw error;
  }
  return new mongoose.Types.ObjectId(value);
}

function maybeObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : undefined;
}

function queryWithSession(query, session) {
  return session ? query.session(session) : query;
}

function getRequestHospitalId(req) {
  return req?.user?.hospital_id || req?.user?.hospitalId || req?.body?.hospitalId;
}

function getRequestUserId(req) {
  return req?.user?._id || req?.user?.id;
}

function isSuperAdmin(req) {
  return req?.user?.role === 'mediqliq_super_admin';
}

function assertHospitalScope(req, record) {
  const userHospitalId = getRequestHospitalId(req);
  const recordHospitalId = record?.hospitalId || record?.hospital_id;

  if (!isSuperAdmin(req) && userHospitalId && recordHospitalId && String(userHospitalId) !== String(recordHospitalId)) {
    const error = new Error('Cross-hospital access denied.');
    error.status = 403;
    throw error;
  }
}

function lineQuantity(item) {
  return Math.max(0, Number(item.quantity_base_units ?? item.quantity ?? 0));
}

function returnedQuantity(item) {
  return Math.max(0, Number(item.returned_quantity_base_units ?? 0));
}

function resolveSaleItem(sale, inputRow) {
  const saleItemId = inputRow.saleItemId || inputRow.sale_item_id;
  if (saleItemId && sale.items?.id) {
    const byId = sale.items.id(saleItemId);
    if (byId) return byId;
  }

  const medicineId = inputRow.medicineId || inputRow.medicine_id;
  const batchId = inputRow.batchId || inputRow.batch_id;
  const found = (sale.items || []).find((item) =>
    medicineId && String(item.medicine_id) === String(medicineId) &&
    (!batchId || String(item.batch_id) === String(batchId))
  );

  if (!found) {
    const error = new Error('Returned item is not present on the original sale.');
    error.status = 400;
    throw error;
  }
  return found;
}

function lineFinancials(item) {
  const quantity = Math.max(1, lineQuantity(item));
  const gross = nonNegativeMoney(item.gross_amount ?? (Number(item.rate_per_base_unit ?? item.unit_price ?? 0) * quantity));
  const discount = nonNegativeMoney(item.discount_amount ?? item.discount ?? 0);
  const taxable = nonNegativeMoney(item.taxable_amount ?? (gross - discount));
  const taxRate = nonNegativeMoney(item.tax_rate ?? item.gst_rate ?? 0);
  const tax = nonNegativeMoney(item.tax_amount ?? (taxable * taxRate) / 100);
  const net = nonNegativeMoney(item.net_amount ?? item.total_price ?? (taxable + tax));

  return { quantity, gross, discount, taxable, taxRate, tax, net };
}

/**
 * Rebuild return values from the original sale line. Client-provided price,
 * GST, discount and refund amount are intentionally ignored.
 */
function buildAuthoritativeReturnRows(sale, requestedRows = []) {
  if (!Array.isArray(requestedRows) || requestedRows.length === 0) {
    const error = new Error('At least one return item is required.');
    error.status = 400;
    throw error;
  }

  let total = 0;
  const rows = [];

  for (const requestRow of requestedRows) {
    const item = resolveSaleItem(sale, requestRow);
    const requestedQuantity = Number(
      requestRow.returnedQtyBaseUnits ?? requestRow.quantity_base_units ?? requestRow.quantity ?? 0
    );
    const availableQuantity = money(lineQuantity(item) - returnedQuantity(item));

    if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0 || requestedQuantity > availableQuantity + MONEY_EPSILON) {
      const error = new Error(`${item.medicine_name || 'Medicine'} can return at most ${availableQuantity} ${item.base_unit || 'unit'}(s).`);
      error.status = 400;
      throw error;
    }

    const original = lineFinancials(item);
    const proportion = requestedQuantity / original.quantity;
    const grossAmount = money(original.gross * proportion);
    const discountReversal = money(original.discount * proportion);
    const taxableAmount = money(original.taxable * proportion);
    const taxAmount = money(original.tax * proportion);
    const refundAmount = money(original.net * proportion);

    const row = {
      saleItemId: item._id,
      medicineId: item.medicine_id,
      batchId: item.batch_id,
      medicineName: item.medicine_name || requestRow.medicineName || requestRow.medicine_name || 'Medicine',
      returnedQtyBaseUnits: requestedQuantity,
      baseUnit: item.base_unit || 'unit',
      unitsPerPack: Number(item.units_per_pack || 1),
      ratePerBaseUnit: money(refundAmount / requestedQuantity),
      grossAmount,
      discountReversal,
      taxableAmount,
      taxRate: original.taxRate,
      taxAmount,
      refundAmount,
      condition: requestRow.condition || 'SEALED_USABLE',
      restock: requestRow.restock !== false && (requestRow.condition || 'SEALED_USABLE') === 'SEALED_USABLE',
    };

    rows.push(row);
    total = money(total + refundAmount);
  }

  return { rows, total };
}

async function assertOrdinaryReturnAllowed({ sale, req, session }) {
  if (sale.discharge_settlement_id) {
    const error = new Error('This sale was included in final pharmacy clearance. Use the controlled credit-note/reversal process; an ordinary medicine return is blocked.');
    error.status = 409;
    throw error;
  }

  if (sale.admission_id) {
    const admission = await queryWithSession(IPDAdmission.findById(sale.admission_id), session);
    if (!admission) {
      const error = new Error('Linked IPD admission was not found.');
      error.status = 409;
      throw error;
    }
    assertHospitalScope(req, admission);
    if (admission.pharmacyClearanceStatus === 'cleared') {
      const error = new Error('Pharmacy clearance is already complete. Use the controlled credit-note/reversal process; an ordinary medicine return is blocked.');
      error.status = 409;
      throw error;
    }
    return admission;
  }
  return null;
}

async function buildReturnPreview({ saleId, items, req, session }) {
  const sale = await queryWithSession(Sale.findById(asObjectId(saleId, 'saleId')), session);
  if (!sale) {
    const error = new Error('Original sale was not found.');
    error.status = 404;
    throw error;
  }
  assertHospitalScope(req, sale);
  const admission = await assertOrdinaryReturnAllowed({ sale, req, session });
  const { rows, total } = buildAuthoritativeReturnRows(sale, items);
  const allocation = calculateReturnAllocation(sale, total);

  return { sale, admission, rows, returnValue: total, allocation };
}

async function restockAcceptedRows({ rows, sale, returnRecord, createdBy, session }) {
  for (const row of rows) {
    if (!row.restock) continue;
    if (!row.batchId) {
      const error = new Error(`${row.medicineName} has no original batch and cannot be returned to stock.`);
      error.status = 409;
      throw error;
    }

    const batch = await MedicineBatch.findById(row.batchId).session(session);
    if (!batch) {
      const error = new Error(`Original batch was not found for ${row.medicineName}.`);
      error.status = 409;
      throw error;
    }

    const nextQuantity = Number(batch.quantity_base_units ?? batch.quantity ?? 0) + Number(row.returnedQtyBaseUnits);
    batch.quantity_base_units = nextQuantity;
    batch.quantity = nextQuantity;
    await batch.save({ session });

    await InventoryLedger.create([{
      hospitalId: sale.hospitalId,
      pharmacyId: sale.pharmacy_id,
      medicineId: row.medicineId,
      batchId: row.batchId,
      movementType: 'RETURN_IN',
      direction: 'IN',
      quantityBaseUnits: row.returnedQtyBaseUnits,
      balanceAfterBaseUnits: nextQuantity,
      sourceModule: 'PharmacyReturn',
      sourceId: returnRecord._id,
      notes: `Return ${returnRecord.returnNumber} accepted into stock`,
      createdBy,
    }], { session });
  }
}

function setSaleAfterReturn({ sale, returnRecord, total, allocation }) {
  for (const row of returnRecord.items) {
    const item = sale.items.id(row.saleItemId);
    if (!item) continue;
    item.returned_quantity_base_units = money(Number(item.returned_quantity_base_units || 0) + Number(row.returnedQtyBaseUnits || 0));
    item.returned_amount = money(Number(item.returned_amount || 0) + Number(row.refundAmount || 0));
  }

  sale.return_amount = money(Number(sale.return_amount || 0) + total);
  sale.refunded_amount = money(Number(sale.refunded_amount || 0) + allocation.refundableResidual);
  sale.net_amount_after_returns = allocation.netAfter;
  sale.amount_paid = allocation.paidRetainedAfter;
  sale.balance_due = allocation.dueAfter;
  sale.closing_outstanding = allocation.dueAfter;
  sale.payment_deferred = allocation.dueAfter > MONEY_EPSILON;
  sale.status = allocation.netAfter <= MONEY_EPSILON
    ? 'Refunded'
    : allocation.dueAfter > MONEY_EPSILON
      ? 'PartiallyReturned'
      : 'Completed';

  sale.return_refs = sale.return_refs || [];
  sale.return_refs.push({
    return_id: returnRecord._id,
    return_number: returnRecord.returnNumber,
    amount: total,
    returned_at: new Date(),
  });
}

async function postReturnLedger({ sale, returnRecord, allocation, refundMode, createdBy, transactionGroupId, idempotencyKey, session }) {
  const entries = [];

  if (allocation.outstandingReduction > MONEY_EPSILON) {
    entries.push({
      hospitalId: sale.hospitalId,
      pharmacyId: sale.pharmacy_id,
      entryType: 'RETURN',
      direction: 'NON_CASH',
      amount: allocation.outstandingReduction,
      paymentMethod: 'Deferred',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      returnId: returnRecord._id,
      notes: `Return ${returnRecord.returnNumber}: reduced original outstanding due by ₹${allocation.outstandingReduction}.`,
      createdBy,
      transactionGroupId,
      parentGroupId: transactionGroupId,
      idempotencyKey: `${idempotencyKey}:due`,
      presentationType: 'RETURN_APPLIED_TO_OUTSTANDING',
    });
  }

  if (allocation.refundableResidual > MONEY_EPSILON) {
    if (['PharmacyAdvance', 'IPDAdvance'].includes(refundMode)) {
      await createAdvanceLedgerEntry({
        hospitalId: sale.hospitalId,
        patientId: sale.patient_id,
        admissionId: sale.admission_id,
        walletType: refundMode === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED',
        transactionType: 'PHARMACY_RETURN_CREDIT',
        direction: 'CREDIT',
        amount: allocation.refundableResidual,
        paymentMethod: refundMode,
        referenceNumber: returnRecord.returnNumber,
        sourceModule: 'Pharmacy',
        sourceId: returnRecord._id,
        notes: `Refundable paid residual from return ${returnRecord.returnNumber}.`,
        createdBy,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey: `${idempotencyKey}:wallet`,
        presentationType: 'REFUND_OR_WALLET_RESTORATION',
        session,
      });
    }

    entries.push({
      hospitalId: sale.hospitalId,
      pharmacyId: sale.pharmacy_id,
      entryType: CASH_REFUND_METHODS.has(refundMode) ? 'REFUND' : 'RETURN',
      direction: CASH_REFUND_METHODS.has(refundMode) ? 'OUT' : 'NON_CASH',
      amount: allocation.refundableResidual,
      paymentMethod: refundMode,
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      returnId: returnRecord._id,
      notes: `Return ${returnRecord.returnNumber}: refundable paid residual ₹${allocation.refundableResidual} via ${refundMode}.`,
      createdBy,
      transactionGroupId,
      parentGroupId: transactionGroupId,
      idempotencyKey: `${idempotencyKey}:refund`,
      presentationType: 'REFUND_OR_WALLET_RESTORATION',
    });
  }

  if (entries.length) await PharmacyLedgerEntry.create(entries, { session });
}

async function completeAuthoritativeReturn({ payload, req }) {
  const idempotencyKey = String(req.headers?.['idempotency-key'] || payload.idempotencyKey || '').trim();
  if (!idempotencyKey) {
    const error = new Error('Idempotency-Key is required to post a medicine return.');
    error.status = 400;
    throw error;
  }

  const requestedSaleId = payload.saleId || payload.originalSaleId || payload.original_sale_id || payload.sale_id;
  const createdBy = getRequestUserId(req);
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const duplicate = await PharmacyReturn.findOne({ idempotencyKey }).session(session);
      if (duplicate) {
        result = { idempotent: true, returnRecord: duplicate };
        return;
      }

      const preview = await buildReturnPreview({ saleId: requestedSaleId, items: payload.items, req, session });
      const { sale, admission, rows, returnValue, allocation } = preview;

      const requestedRefundMode = String(payload.refundMode || payload.refund_mode || 'NoRefund');
      const refundMode = allocation.refundableResidual > MONEY_EPSILON ? requestedRefundMode : 'NoRefund';

      if (allocation.refundableResidual > MONEY_EPSILON && !REFUND_METHODS.has(refundMode)) {
        const error = new Error('Choose a valid refund method only for the paid/refundable residual.');
        error.status = 400;
        throw error;
      }

      const transactionGroupId = newBusinessGroup(payload.transactionGroupId || idempotencyKey);
      const [returnRecord] = await PharmacyReturn.create([{
        hospitalId: sale.hospitalId,
        pharmacyId: sale.pharmacy_id,
        originalSaleId: sale._id,
        originalSaleNumber: sale.sale_number,
        originalInvoiceId: sale.invoice_id,
        patientId: sale.patient_id,
        admissionId: sale.admission_id,
        returnType: payload.returnType || (sale.admission_id ? 'IPD_UNUSED_MEDICINE' : sale.patient_id ? 'OPD_RETURN' : 'WALKIN_RETURN'),
        items: rows,
        totalRefundAmount: returnValue,
        dueBefore: allocation.dueBefore,
        outstandingReduction: allocation.outstandingReduction,
        refundableResidual: allocation.refundableResidual,
        dueAfter: allocation.dueAfter,
        refundMode,
        refundReference: payload.refundReference || payload.refund_reference || '',
        status: 'Completed',
        notes: payload.notes || '',
        createdBy,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey,
        presentationType: allocation.refundableResidual > MONEY_EPSILON ? 'RETURN_WITH_REFUND' : 'RETURN_APPLIED_TO_OUTSTANDING',
      }], { session });

      await restockAcceptedRows({ rows, sale, returnRecord, createdBy, session });
      setSaleAfterReturn({ sale, returnRecord, total: returnValue, allocation });
      await sale.save({ session });
      await postReturnLedger({ sale, returnRecord, allocation, refundMode, createdBy, transactionGroupId, idempotencyKey, session });

      const walletAfter = sale.patient_id
        ? await getAdvanceBalance({ patientId: sale.patient_id, admissionId: sale.admission_id, walletType: 'PHARMACY_IPD', session })
        : 0;
      returnRecord.patientOutstandingAfter = allocation.dueAfter;
      returnRecord.pharmacyAdvanceAfter = walletAfter;
      await returnRecord.save({ session });

      if (admission && admission.pharmacyClearanceStatus === 'in_progress') {
        admission.pharmacyFinalBalance = allocation.dueAfter;
        await admission.save({ session });
      }

      result = { idempotent: false, returnRecord, allocation, transactionGroupId };
    });

    return result;
  } finally {
    session.endSession();
  }
}

/**
 * Create a settlement plan without writing data. A final pharmacy clearance is
 * allowed to settle outstanding dues; it is not a zero-due-only status toggle.
 */
function normalizeIncomingPayments(rawPayments = []) {
  if (!Array.isArray(rawPayments)) {
    const error = new Error('payments must be an array of payment allocations.');
    error.status = 400;
    throw error;
  }

  const payments = rawPayments
    .map((row) => ({
      method: String(row.method || row.paymentMethod || '').trim(),
      amount: money(row.amount),
      reference: String(row.reference || row.referenceNumber || '').trim(),
    }))
    .filter((row) => row.amount > MONEY_EPSILON);

  for (const row of payments) {
    if (!CLEARANCE_PAYMENT_METHODS.has(row.method)) {
      const error = new Error(`Unsupported final-clearance payment method: ${row.method || 'blank'}.`);
      error.status = 400;
      throw error;
    }
  }
  return payments;
}

function normalizeClearanceRequest(snapshot, payload = {}) {
  const payments = normalizeIncomingPayments(payload.payments || payload.paymentAllocations || []);
  const paymentTotal = money(payments.reduce((sum, payment) => sum + payment.amount, 0));
  const amounts = calculateFinalClearanceAmounts({
    outstanding: snapshot.outstanding,
    pharmacyAdvanceAvailable: snapshot.pharmacyAdvance,
    ipdAdvanceAvailable: snapshot.ipdAdvance,
    pharmacyAdvanceApplied: payload.pharmacyAdvanceApplied === undefined
      ? Math.min(snapshot.pharmacyAdvance, snapshot.outstanding)
      : payload.pharmacyAdvanceApplied,
    ipdAdvanceApplied: payload.ipdAdvanceApplied || 0,
    paymentTotal,
  });

  const unusedAdvanceDisposition = amounts.unusedPharmacyAdvance > MONEY_EPSILON
    ? String(payload.unusedPharmacyAdvanceDisposition || 'refund').toLowerCase()
    : 'none';
  if (!['refund', 'retain', 'none'].includes(unusedAdvanceDisposition)) {
    const error = new Error('unusedPharmacyAdvanceDisposition must be refund or retain.');
    error.status = 400;
    throw error;
  }

  let refund = null;
  if (amounts.unusedPharmacyAdvance > MONEY_EPSILON && unusedAdvanceDisposition === 'refund') {
    const method = String(payload.refundMethod || payload.refund?.method || '').trim();
    const amount = payload.refundAmount === undefined && payload.refund?.amount === undefined
      ? amounts.unusedPharmacyAdvance
      : money(payload.refundAmount ?? payload.refund?.amount);
    const reference = String(payload.refundReference || payload.refund?.reference || '').trim();
    if (!CASH_REFUND_METHODS.has(method)) {
      const error = new Error('Choose Cash, UPI, Card, Bank or Net Banking for the unused Pharmacy Advance refund.');
      error.status = 400;
      throw error;
    }
    if (Math.abs(amount - amounts.unusedPharmacyAdvance) > MONEY_EPSILON) {
      const error = new Error(`Unused Pharmacy Advance refund must equal ₹${amounts.unusedPharmacyAdvance}. Partial/unexplained wallet balances cannot be finalized.`);
      error.status = 400;
      throw error;
    }
    refund = { method, amount, reference };
  }

  return { ...amounts, payments, unusedAdvanceDisposition, refund };
}

function buildSaleAllocationPlan(sales, sources) {
  const orderedSales = [...sales]
    .filter((sale) => money(sale.balance_due) > MONEY_EPSILON)
    .sort((a, b) => new Date(a.sale_date || 0) - new Date(b.sale_date || 0));
  const remaining = sources.map((source) => ({ ...source, amount: money(source.amount) }));
  const allocations = [];

  for (const sale of orderedSales) {
    let due = money(sale.balance_due);
    const openingDue = due;
    const paymentBreakdown = [];

    for (const source of remaining) {
      if (due <= MONEY_EPSILON || source.amount <= MONEY_EPSILON) continue;
      const used = money(Math.min(due, source.amount));
      due = money(due - used);
      source.amount = money(source.amount - used);
      paymentBreakdown.push({
        method: source.method,
        amount: used,
        reference: source.reference || '',
        walletType: source.walletType || null,
      });
    }

    if (due > MONEY_EPSILON) {
      const error = new Error(`Settlement allocation did not fully cover sale ${sale.sale_number || sale._id}.`);
      error.status = 409;
      throw error;
    }

    allocations.push({
      sale_id: sale._id,
      sale_number: sale.sale_number,
      bill_id: sale.bill_id || undefined,
      invoice_id: sale.invoice_id || undefined,
      opening_due: openingDue,
      opening_paid: money(sale.amount_paid),
      gross_amount: money(sale.total_amount),
      existing_discounts: 0,
      payment_allocated: money(paymentBreakdown.reduce((sum, row) => sum + row.amount, 0)),
      settlement_discount_allocated: 0,
      credit_note_allocated: 0,
      unapplied_discount: 0,
      closing_due: 0,
      payment_breakdown: paymentBreakdown,
    });
  }

  if (remaining.some((source) => source.amount > MONEY_EPSILON)) {
    const error = new Error('Settlement sources exceed the actual open pharmacy due.');
    error.status = 400;
    throw error;
  }

  return allocations;
}

async function getClearanceSnapshot({ admissionId, req, session }) {
  const admission = await queryWithSession(IPDAdmission.findById(asObjectId(admissionId, 'admissionId')), session);
  if (!admission) {
    const error = new Error('Admission not found.');
    error.status = 404;
    throw error;
  }
  assertHospitalScope(req, admission);

  const sales = await queryWithSession(
    Sale.find({
      admission_id: admission._id,
      status: { $ne: 'Cancelled' },
      include_in_discharge_clearance: { $ne: false },
    })
      .select('sale_number sale_date total_amount net_amount_after_returns amount_paid refunded_amount balance_due return_amount payment_deferred payments updatedAt discharge_settlement_id status transactionGroupId pharmacy_id'),
    session
  );

  const pendingReturns = await queryWithSession(
    PharmacyReturn.find({ admissionId: admission._id, status: { $in: ['PendingApproval'] } })
      .select('returnNumber totalRefundAmount status updatedAt originalSaleId'),
    session
  );

  const [pharmacyAdvance, ipdAdvance] = await Promise.all([
    getAdvanceBalance({ patientId: admission.patientId, admissionId: admission._id, walletType: 'PHARMACY_IPD', session }),
    getAdvanceBalance({ patientId: admission.patientId, admissionId: admission._id, walletType: 'IPD_SHARED', session }),
  ]);

  const outstanding = money(sales.reduce((sum, sale) => sum + Number(sale.balance_due || 0), 0));
  const returnValue = money(sales.reduce((sum, sale) => sum + Number(sale.return_amount || 0), 0));
  const paidRetained = money(sales.reduce((sum, sale) => sum + Number(sale.amount_paid || 0), 0));
  const defaultPharmacyAdvanceApplied = money(Math.min(outstanding, Number(pharmacyAdvance || 0)));
  const defaultCashToCollect = money(outstanding - defaultPharmacyAdvanceApplied);
  const projectedUnusedPharmacyAdvance = money(Number(pharmacyAdvance || 0) - defaultPharmacyAdvanceApplied);

  const sourceVersionPayload = {
    admission: [String(admission._id), admission.updatedAt?.toISOString?.() || null, admission.pharmacyClearanceStatus],
    sales: sales.map((sale) => [
      String(sale._id), sale.updatedAt?.toISOString?.() || null,
      Number(sale.balance_due || 0), Number(sale.return_amount || 0), Number(sale.refunded_amount || 0), String(sale.discharge_settlement_id || ''),
    ]),
    pendingReturns: pendingReturns.map((record) => [String(record._id), record.updatedAt?.toISOString?.() || null, record.status]),
    balances: [money(pharmacyAdvance), money(ipdAdvance)],
  };

  const sourceVersion = crypto.createHash('sha256').update(JSON.stringify(sourceVersionPayload)).digest('hex');

  return {
    admission,
    sales,
    pendingReturns,
    outstanding,
    returnValue,
    paidRetained,
    pharmacyAdvance: money(pharmacyAdvance),
    ipdAdvance: money(ipdAdvance),
    suggestedSettlement: {
      pharmacyAdvanceApplied: defaultPharmacyAdvanceApplied,
      cashToCollect: defaultCashToCollect,
      unusedPharmacyAdvanceAfterApplication: projectedUnusedPharmacyAdvance,
    },
    sourceVersion,
    generatedAt: new Date(),
  };
}

async function postClearanceAdvanceDebits({ plan, snapshot, settlement, req, transactionGroupId, idempotencyKey, session }) {
  const createdBy = getRequestUserId(req);
  const common = {
    hospitalId: snapshot.admission.hospitalId,
    patientId: snapshot.admission.patientId,
    admissionId: snapshot.admission._id,
    sourceModule: 'Pharmacy',
    sourceId: settlement._id,
    createdBy,
    transactionGroupId,
    parentGroupId: transactionGroupId,
    session,
  };

  if (plan.pharmacyAdvanceApplied > MONEY_EPSILON) {
    await createAdvanceLedgerEntry({
      ...common,
      walletType: 'PHARMACY_IPD',
      transactionType: 'OUTSTANDING_SETTLEMENT_DEBIT',
      direction: 'DEBIT',
      amount: plan.pharmacyAdvanceApplied,
      paymentMethod: 'PharmacyAdvance',
      referenceNumber: settlement.settlement_number,
      idempotencyKey: `${idempotencyKey}:pharmacy-advance-used`,
      presentationType: 'CLEARANCE_ADVANCE_APPLIED',
      notes: `Final pharmacy clearance applied Pharmacy Advance to open sale dues.`,
    });
  }

  if (plan.ipdAdvanceApplied > MONEY_EPSILON) {
    await createAdvanceLedgerEntry({
      ...common,
      walletType: 'IPD_SHARED',
      transactionType: 'OUTSTANDING_SETTLEMENT_DEBIT',
      direction: 'DEBIT',
      amount: plan.ipdAdvanceApplied,
      paymentMethod: 'IPDAdvance',
      referenceNumber: settlement.settlement_number,
      idempotencyKey: `${idempotencyKey}:ipd-advance-used`,
      presentationType: 'CLEARANCE_ADVANCE_APPLIED',
      notes: `Final pharmacy clearance applied shared IPD Advance to open sale dues.`,
    });
  }

  if (plan.refund) {
    await createAdvanceLedgerEntry({
      ...common,
      walletType: 'PHARMACY_IPD',
      transactionType: 'PHARMACY_ADVANCE_REFUND',
      direction: 'DEBIT',
      amount: plan.refund.amount,
      paymentMethod: plan.refund.method,
      referenceNumber: plan.refund.reference || settlement.settlement_number,
      idempotencyKey: `${idempotencyKey}:pharmacy-advance-refund`,
      presentationType: 'CLEARANCE_UNUSED_ADVANCE_REFUND',
      notes: `Unused Pharmacy Advance refunded during final clearance.`,
    });
  }
}

async function applyClearanceAllocationToSales({ snapshot, allocations, settlement, req, transactionGroupId, idempotencyKey, session }) {
  const entries = [];
  const bySaleId = new Map(snapshot.sales.map((sale) => [String(sale._id), sale]));
  const createdBy = getRequestUserId(req);

  for (const allocation of allocations) {
    const sale = bySaleId.get(String(allocation.sale_id));
    if (!sale) continue;

    const settlementAmount = money(allocation.payment_allocated);
    sale.amount_paid = money(Number(sale.amount_paid || 0) + settlementAmount);
    sale.settlement_amount = money(Number(sale.settlement_amount || 0) + settlementAmount);
    sale.balance_due = 0;
    sale.closing_outstanding = 0;
    sale.payment_deferred = false;
    if (currentSaleNet(sale) > MONEY_EPSILON) sale.status = 'Completed';
    sale.payment_method = allocation.payment_breakdown.length > 1
      ? 'Split'
      : (allocation.payment_breakdown[0]?.method || sale.payment_method);
    sale.payments = sale.payments || [];
    for (const [rowIndex, row] of allocation.payment_breakdown.entries()) {
      sale.payments.push({
        method: row.method,
        amount: row.amount,
        reference: row.reference || '',
        walletType: row.walletType || null,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey: `${idempotencyKey}:${String(sale._id)}:${row.method}:${rowIndex}`,
        presentationType: 'FINAL_CLEARANCE_ALLOCATION',
      });
      entries.push({
        hospitalId: snapshot.admission.hospitalId,
        pharmacyId: sale.pharmacy_id,
        entryType: row.walletType ? 'ADVANCE_USED' : 'OUTSTANDING_PAYMENT',
        direction: row.walletType ? 'NON_CASH' : 'IN',
        amount: row.amount,
        paymentMethod: row.method,
        patientId: snapshot.admission.patientId,
        admissionId: snapshot.admission._id,
        saleId: sale._id,
        settlementId: settlement._id,
        notes: `Final clearance allocation to sale ${sale.sale_number || sale._id}.`,
        createdBy,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey: `${idempotencyKey}:${String(sale._id)}:${row.method}:${rowIndex}`,
        presentationType: 'FINAL_CLEARANCE_ALLOCATION',
      });
    }
    sale.discharge_settlement_id = settlement._id;
    sale.discharged_settled_at = new Date();
    sale.settlement_refs = sale.settlement_refs || [];
    sale.settlement_refs.push({ sale_id: sale._id, amount: settlementAmount, settled_at: new Date() });
    await sale.save({ session });
  }

  if (entries.length) await PharmacyLedgerEntry.create(entries, { session });
}

async function completeFinalClearance({ admissionId, payload, req }) {
  const idempotencyKey = String(req.headers?.['idempotency-key'] || payload.idempotencyKey || '').trim();
  if (!idempotencyKey) {
    const error = new Error('Idempotency-Key is required to complete final pharmacy clearance.');
    error.status = 400;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const duplicate = await PharmacyLedgerSettlement.findOne({ idempotency_key: idempotencyKey }).session(session);
      if (duplicate) {
        result = { idempotent: true, settlement: duplicate };
        return;
      }

      const snapshot = await getClearanceSnapshot({ admissionId, req, session });
      if (!payload.sourceVersion || payload.sourceVersion !== snapshot.sourceVersion) {
        const error = new Error('Clearance preview is stale. Refresh the source-of-truth preview before posting.');
        error.status = 409;
        throw error;
      }
      if (snapshot.admission.pharmacyClearanceStatus === 'cleared') {
        const error = new Error('Pharmacy clearance is already complete.');
        error.status = 409;
        throw error;
      }
      if (snapshot.pendingReturns.length > 0) {
        const error = new Error('Pending return requests must be resolved before final pharmacy clearance.');
        error.status = 409;
        throw error;
      }

      const plan = normalizeClearanceRequest(snapshot, payload);
      const sources = [
        ...(plan.pharmacyAdvanceApplied > MONEY_EPSILON ? [{ method: 'PharmacyAdvance', amount: plan.pharmacyAdvanceApplied, walletType: 'PHARMACY_IPD', reference: '' }] : []),
        ...(plan.ipdAdvanceApplied > MONEY_EPSILON ? [{ method: 'IPDAdvance', amount: plan.ipdAdvanceApplied, walletType: 'IPD_SHARED', reference: '' }] : []),
        ...plan.payments.map((payment) => ({ ...payment, walletType: null })),
      ];
      const allocations = buildSaleAllocationPlan(snapshot.sales, sources);
      const transactionGroupId = newBusinessGroup(payload.transactionGroupId || idempotencyKey);
      const [settlement] = await PharmacyLedgerSettlement.create([{
        hospital_id: snapshot.admission.hospitalId,
        pharmacy_id: snapshot.sales[0]?.pharmacy_id,
        patient_id: snapshot.admission.patientId,
        admission_id: snapshot.admission._id,
        settlement_type: 'FINAL_CLEARANCE',
        discount_scope: 'UNPAID_DUE',
        discount_type: 'FIXED',
        discount_value: 0,
        allocation_policy: 'FIFO',
        opening_ledger_gross: money(snapshot.sales.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0)),
        opening_ledger_net: money(snapshot.sales.reduce((sum, sale) => sum + currentSaleNet(sale), 0)),
        opening_paid_total: snapshot.paidRetained,
        opening_outstanding_total: snapshot.outstanding,
        existing_discount_total: 0,
        calculated_discount: 0,
        discount_applied: 0,
        discount_unapplied: 0,
        payment_received: plan.paymentTotal,
        patient_credit_created: 0,
        patient_credit_disposition: plan.unusedAdvanceDisposition === 'retain' ? 'PHARMACY_ADVANCE' : 'NONE',
        payment_breakdown: sources.map((source) => ({
          method: source.method,
          amount: source.amount,
          reference: source.reference || '',
          walletType: source.walletType || null,
        })),
        allocations,
        reason: payload.notes || 'Final pharmacy clearance settled all open sale dues and reconciled Pharmacy Advance.',
        created_by: getRequestUserId(req),
        idempotency_key: idempotencyKey,
        transactionGroupId,
        parentGroupId: transactionGroupId,
        presentationType: 'FINAL_PHARMACY_CLEARANCE',
        unusedPharmacyAdvanceDisposition: plan.unusedAdvanceDisposition,
        unusedPharmacyAdvanceAmount: plan.remainingPharmacyAdvance,
        unusedPharmacyAdvanceRefundMethod: plan.refund?.method || null,
        unusedPharmacyAdvanceRefundReference: plan.refund?.reference || '',
      }], { session });

      await postClearanceAdvanceDebits({ plan, snapshot, settlement, req, transactionGroupId, idempotencyKey, session });
      await applyClearanceAllocationToSales({ snapshot, allocations, settlement, req, transactionGroupId, idempotencyKey, session });
      // Mark every eligible sale in this admission as included in the clearance,
      // including already-paid sales that did not need a new allocation today.
      await Sale.updateMany(
        { _id: { $in: snapshot.sales.map((sale) => sale._id) } },
        { $set: { discharge_settlement_id: settlement._id, discharged_settled_at: new Date() } },
        { session }
      );

      const finalPharmacyAdvance = await getAdvanceBalance({
        patientId: snapshot.admission.patientId,
        admissionId: snapshot.admission._id,
        walletType: 'PHARMACY_IPD',
        session,
      });
      if (plan.unusedAdvanceDisposition === 'refund' && money(finalPharmacyAdvance) > MONEY_EPSILON) {
        const error = new Error('Unused Pharmacy Advance refund did not reconcile to zero. Clearance was not finalized.');
        error.status = 409;
        throw error;
      }

      snapshot.admission.pharmacyClearanceStatus = 'cleared';
      snapshot.admission.pharmacyClearanceDate = new Date();
      snapshot.admission.pharmacyClearanceBy = getRequestUserId(req);
      snapshot.admission.pharmacyFinalBalance = 0;
      await snapshot.admission.save({ session });

      const clearanceEntries = [{
        hospitalId: snapshot.admission.hospitalId,
        pharmacyId: snapshot.sales[0]?.pharmacy_id,
        entryType: 'FINAL_CLEARANCE',
        direction: 'NON_CASH',
        amount: 0,
        paymentMethod: 'Adjustment',
        patientId: snapshot.admission.patientId,
        admissionId: snapshot.admission._id,
        settlementId: settlement._id,
        notes: 'Final pharmacy clearance completed after settlement, advance application and unused advance disposition.',
        createdBy: getRequestUserId(req),
        transactionGroupId,
        parentGroupId: transactionGroupId,
        idempotencyKey,
        presentationType: 'FINAL_PHARMACY_CLEARANCE',
      }];
      if (plan.refund) {
        clearanceEntries.push({
          hospitalId: snapshot.admission.hospitalId,
          pharmacyId: snapshot.sales[0]?.pharmacy_id,
          entryType: 'REFUND',
          direction: 'OUT',
          amount: plan.refund.amount,
          paymentMethod: plan.refund.method,
          patientId: snapshot.admission.patientId,
          admissionId: snapshot.admission._id,
          settlementId: settlement._id,
          notes: `Unused Pharmacy Advance refunded during final clearance.`,
          createdBy: getRequestUserId(req),
          transactionGroupId,
          parentGroupId: transactionGroupId,
          idempotencyKey: `${idempotencyKey}:advance-refund-ledger`,
          presentationType: 'CLEARANCE_UNUSED_ADVANCE_REFUND',
        });
      }
      await PharmacyLedgerEntry.create(clearanceEntries, { session });

      result = { idempotent: false, settlement, plan, sourceVersion: snapshot.sourceVersion };
    });

    return result;
  } finally {
    session.endSession();
  }
}

module.exports = {
  money,
  buildAuthoritativeReturnRows,
  calculateReturnAllocation,
  buildReturnPreview,
  completeAuthoritativeReturn,
  getClearanceSnapshot,
  normalizeClearanceRequest,
  buildSaleAllocationPlan,
  completeFinalClearance,
};
