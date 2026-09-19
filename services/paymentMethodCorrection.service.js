const mongoose = require('mongoose');
const FinancialTransaction = require('../models/FinancialTransaction');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const { operationNow } = require('../utils/operationTimeContext');
const { appendDomainEvent } = require('./auditEvent.service');

const CORRECTABLE_TRANSACTION_TYPES = new Set(['RECEIPT', 'ADVANCE_DEPOSIT']);
const CORRECTABLE_METHODS = new Set([
  'Cash',
  'Card',
  'UPI',
  'Net Banking',
  'Insurance',
  'Government Scheme',
  'Bank'
]);
const REFERENCE_REQUIRED_METHODS = new Set(['Card', 'UPI', 'Net Banking', 'Bank']);
const ADVANCE_CORRECTABLE_METHODS = new Set(['Cash', 'Card', 'UPI', 'Net Banking', 'Bank']);

function financialError(message, statusCode = 400, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

function normaliseMethod(value) {
  const raw = String(value || '').trim();
  const match = [...CORRECTABLE_METHODS].find((method) => method.toLowerCase() === raw.toLowerCase());
  return match || raw;
}

function idString(value) {
  if (!value) return '';
  return String(value?._id || value);
}

function correctionAudit({ fromMethod, toMethod, oldReference, newReference, reason, userId, correctedAt }) {
  return {
    fromMethod,
    toMethod,
    oldReference: oldReference || undefined,
    newReference: newReference || undefined,
    reason,
    correctedBy: userId || undefined,
    correctedAt
  };
}

function matchingReceiptPayment(row, receiptNumber) {
  const receipt = String(receiptNumber || '');
  return [row?.receipt_number, row?.transaction_id, row?.receiptNumber, row?.transactionNumber]
    .filter(Boolean)
    .some((value) => String(value) === receipt);
}

function matchingBillPayment(row, receiptNumber) {
  const receipt = String(receiptNumber || '');
  return [row?.receipt_number, row?.transaction_id, row?.reference]
    .filter(Boolean)
    .some((value) => String(value) === receipt);
}

function recomputeBillPaymentMethod(bill, linkedInvoices = []) {
  const methods = [];
  for (const payment of bill.payments || []) {
    if (payment?.method && payment.method !== 'Adjustment') methods.push(payment.method);
  }
  for (const invoice of linkedInvoices) {
    for (const payment of invoice.payment_history || []) {
      if (payment?.status === 'Completed' && payment?.method && payment.method !== 'Adjustment') {
        methods.push(payment.method);
      }
    }
  }
  const unique = [...new Set(methods.filter(Boolean))];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return 'Split';
  return bill.payment_method;
}

function transactionLookup(transactionIdOrNumber, hospitalId) {
  const clauses = [{ transactionNumber: String(transactionIdOrNumber || '').trim().toUpperCase() }];
  if (mongoose.Types.ObjectId.isValid(transactionIdOrNumber)) clauses.unshift({ _id: transactionIdOrNumber });
  return { hospitalId, $or: clauses };
}

async function correctPaymentMethod({ transactionIdOrNumber, hospitalId, payload, user, req }) {
  const toMethod = normaliseMethod(payload?.paymentMethod || payload?.method);
  const newReference = String(payload?.paymentReference ?? payload?.reference ?? '').trim();
  const reason = String(payload?.reason || '').trim();

  if (!CORRECTABLE_METHODS.has(toMethod)) {
    throw financialError('Choose a supported payment mode for the correction', 400, 'PAYMENT_MODE_CORRECTION_METHOD_INVALID');
  }
  if (!reason) {
    throw financialError('Correction reason is required', 400, 'PAYMENT_MODE_CORRECTION_REASON_REQUIRED');
  }
  if (REFERENCE_REQUIRED_METHODS.has(toMethod) && !newReference) {
    throw financialError(`${toMethod} reference / transaction ID is required`, 400, 'PAYMENT_MODE_CORRECTION_REFERENCE_REQUIRED');
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const seed = await FinancialTransaction.findOne(
        transactionLookup(transactionIdOrNumber, hospitalId),
        null,
        { session }
      );
      if (!seed) throw financialError('Financial transaction not found', 404, 'PAYMENT_TRANSACTION_NOT_FOUND');
      if (seed.status !== 'POSTED' || !CORRECTABLE_TRANSACTION_TYPES.has(String(seed.transactionType || '').toUpperCase())) {
        throw financialError('Only posted payment or advance receipts can have their payment mode corrected', 409, 'PAYMENT_MODE_CORRECTION_NOT_ALLOWED');
      }
      if (seed.externalMoneyMovement === false) {
        throw financialError('Wallet utilisation and non-cash adjustments cannot be reclassified as an external payment mode', 409, 'PAYMENT_MODE_CORRECTION_NON_CASH');
      }

      const receiptNumber = String(seed.transactionNumber || '').trim();
      const groupedTransactions = await FinancialTransaction.find({
        hospitalId,
        transactionNumber: receiptNumber,
        status: 'POSTED',
        transactionType: { $in: [...CORRECTABLE_TRANSACTION_TYPES] },
        externalMoneyMovement: { $ne: false }
      }).session(session);
      if (!groupedTransactions.length) throw financialError('Receipt transaction group was not found', 404, 'PAYMENT_RECEIPT_GROUP_NOT_FOUND');
      if (groupedTransactions.some((transaction) => transaction.transactionType === 'ADVANCE_DEPOSIT') && !ADVANCE_CORRECTABLE_METHODS.has(toMethod)) {
        throw financialError('Advance receipts can be corrected only to Cash, Card, UPI, Net Banking or Bank', 400, 'PAYMENT_MODE_CORRECTION_ADVANCE_METHOD_INVALID');
      }

      const currentMethods = new Set();
      for (const transaction of groupedTransactions) {
        const method = String(transaction.paymentMethod || '').trim();
        if (!method || method === 'Split') {
          throw financialError('Split-tender receipts need a dedicated split-payment correction workflow', 409, 'PAYMENT_MODE_CORRECTION_SPLIT_UNSUPPORTED');
        }
        currentMethods.add(method);
        const breakdownMethods = new Set((transaction.paymentBreakdown || []).map((row) => row?.method).filter(Boolean));
        if (breakdownMethods.size > 1 || breakdownMethods.has('IPDAdvance') || breakdownMethods.has('OPDAdvance') || breakdownMethods.has('PharmacyAdvance')) {
          throw financialError('Receipts that combine cash/digital tender with advance utilisation cannot be changed with the simple payment-mode correction', 409, 'PAYMENT_MODE_CORRECTION_SPLIT_UNSUPPORTED');
        }
      }
      if (currentMethods.size !== 1) {
        throw financialError('The receipt contains more than one payment mode and requires manual finance reconciliation', 409, 'PAYMENT_MODE_CORRECTION_MIXED_RECEIPT');
      }

      const fromMethod = [...currentMethods][0];
      const oldReference = String(seed.paymentReference || '').trim();
      if (fromMethod === toMethod && oldReference === newReference) {
        throw financialError('The payment already has this mode and reference', 409, 'PAYMENT_MODE_CORRECTION_NO_CHANGE');
      }

      const correctedAt = operationNow();
      const audit = correctionAudit({
        fromMethod,
        toMethod,
        oldReference,
        newReference,
        reason,
        userId: user?._id,
        correctedAt
      });

      const invoiceIds = new Set();
      const billIds = new Set();
      for (const transaction of groupedTransactions) {
        if (transaction.invoiceId) invoiceIds.add(idString(transaction.invoiceId));
        if (transaction.billId) billIds.add(idString(transaction.billId));
        for (const allocation of transaction.documentAllocations || []) {
          if (allocation.documentType === 'Invoice' && allocation.documentId) invoiceIds.add(idString(allocation.documentId));
          if (allocation.documentType === 'Bill' && allocation.documentId) billIds.add(idString(allocation.documentId));
        }

        transaction.paymentMethod = toMethod;
        transaction.paymentReference = newReference || undefined;
        for (const part of transaction.paymentBreakdown || []) {
          if (part.method === fromMethod) {
            part.method = toMethod;
            part.reference = newReference || undefined;
          }
        }
        transaction.paymentMethodCorrections = transaction.paymentMethodCorrections || [];
        transaction.paymentMethodCorrections.push(audit);
        await transaction.save({ session });
      }

      const invoices = invoiceIds.size
        ? await Invoice.find({ _id: { $in: [...invoiceIds] }, hospital_id: hospitalId }).session(session)
        : [];
      for (const invoice of invoices) {
        let changed = false;
        for (const payment of invoice.payment_history || []) {
          if (!matchingReceiptPayment(payment, receiptNumber)) continue;
          payment.correction_history = payment.correction_history || [];
          payment.correction_history.push(audit);
          payment.method = toMethod;
          payment.reference = newReference || undefined;
          for (const part of payment.payment_breakdown || []) {
            if (part.method === fromMethod) {
              part.method = toMethod;
              part.reference = newReference || undefined;
            }
          }
          changed = true;
        }
        if (invoice.bill_id) billIds.add(idString(invoice.bill_id));
        for (const billId of invoice.bill_ids || []) billIds.add(idString(billId));
        if (changed) await invoice.save({ session });
      }

      const bills = billIds.size
        ? await Bill.find({ _id: { $in: [...billIds] }, hospital_id: hospitalId }).session(session)
        : [];
      for (const bill of bills) {
        let changed = false;
        for (const payment of bill.payments || []) {
          if (!matchingBillPayment(payment, receiptNumber)) continue;
          payment.correction_history = payment.correction_history || [];
          payment.correction_history.push(audit);
          payment.method = toMethod;
          payment.receipt_number = payment.receipt_number || receiptNumber;
          payment.payment_reference = newReference || undefined;
          changed = true;
        }
        const linkedInvoices = invoices.filter((invoice) => {
          const linkedIds = [invoice.bill_id, ...(invoice.bill_ids || [])].map(idString).filter(Boolean);
          return linkedIds.includes(idString(bill._id));
        });
        const recomputedMethod = recomputeBillPaymentMethod(bill, linkedInvoices);
        if (recomputedMethod && bill.payment_method !== recomputedMethod) {
          bill.payment_method = recomputedMethod;
          changed = true;
        }
        if (changed) await bill.save({ session });
      }

      const advanceRows = await PatientAdvanceLedger.find({
        hospitalId,
        referenceNumber: receiptNumber,
        status: 'POSTED',
        transactionType: 'ADVANCE_DEPOSIT',
        paymentMethod: fromMethod
      }).session(session);
      for (const ledgerRow of advanceRows) {
        ledgerRow.paymentMethod = toMethod;
        ledgerRow.paymentReference = newReference || undefined;
        ledgerRow.paymentMethodCorrections = ledgerRow.paymentMethodCorrections || [];
        ledgerRow.paymentMethodCorrections.push(audit);
        await ledgerRow.save({ session });
      }

      await appendDomainEvent({
        req,
        eventType: 'finance.payment_method.corrected',
        entityType: 'FinancialTransaction',
        entityId: seed._id,
        hospitalId,
        patientId: seed.patientId,
        encounterId: seed.admissionId,
        beforeSummary: { receiptNumber, paymentMethod: fromMethod, paymentReference: oldReference || undefined },
        afterSummary: { receiptNumber, paymentMethod: toMethod, paymentReference: newReference || undefined },
        reasonCode: reason,
        comments: reason,
        metadata: {
          transactionIds: groupedTransactions.map((row) => row._id),
          invoiceIds: [...invoiceIds],
          billIds: [...billIds],
          correctedAdvanceLedgerRows: advanceRows.length
        },
        session
      });

      result = {
        receiptNumber,
        transactionIds: groupedTransactions.map((row) => row._id),
        fromMethod,
        toMethod,
        oldReference: oldReference || null,
        newReference: newReference || null,
        correctedAt,
        correctedBy: user?._id || null,
        reason,
        affectedInvoices: invoiceIds.size,
        affectedBills: billIds.size,
        affectedAdvanceLedgerRows: advanceRows.length
      };
    });
  } finally {
    await session.endSession();
  }

  return result;
}

module.exports = {
  correctPaymentMethod,
  CORRECTABLE_METHODS,
  REFERENCE_REQUIRED_METHODS
};
