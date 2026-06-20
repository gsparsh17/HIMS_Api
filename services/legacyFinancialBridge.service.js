const FinancialTransaction = require('../models/FinancialTransaction');
const { nextFinancialNumber, money } = require('../utils/financeNumbers');

const RECEIPT_TYPES = ['RECEIPT', 'ADVANCE_UTILISATION', 'SETTLEMENT'];

function normalisePaymentMethod(method) {
  const allowed = ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'Bank', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'];
  return allowed.includes(method) ? method : 'Cash';
}

/**
 * Legacy billing endpoints store payment history on Invoice. The finance module
 * additionally needs an append-only receipt transaction for ledgers and MIS.
 * This function creates only the missing delta, so retries and older invoices
 * cannot double-count collection.
 */
async function syncLegacyInvoiceReceipt({ invoice, bill, user, paymentMethod, reference, remarks }) {
  if (!invoice?._id || !invoice.patient_id) return null;

  const totalPaid = money(invoice.amount_paid || 0);
  if (totalPaid <= 0 || ['Cancelled', 'Refunded'].includes(invoice.status)) return null;

  const existing = await FinancialTransaction.aggregate([
    {
      $match: {
        invoiceId: invoice._id,
        status: 'POSTED',
        transactionType: { $in: RECEIPT_TYPES },
        direction: 'CREDIT'
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const alreadyRecorded = money(existing[0]?.total || 0);
  const outstandingReceipt = money(totalPaid - alreadyRecorded);
  if (outstandingReceipt <= 0) return null;

  const hospitalId = invoice.hospital_id || bill?.hospital_id || user?.hospital_id;
  const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId });
  const method = normalisePaymentMethod(
    paymentMethod || invoice.payment_history?.[invoice.payment_history.length - 1]?.method || bill?.payment_method
  );

  const transaction = await FinancialTransaction.create({
    hospitalId,
    patientId: invoice.patient_id,
    admissionId: invoice.admission_id,
    billId: bill?._id || invoice.bill_id,
    invoiceId: invoice._id,
    transactionNumber: receiptNumber,
    transactionType: method === 'IPDAdvance' ? 'ADVANCE_UTILISATION' : 'RECEIPT',
    direction: 'CREDIT',
    amount: outstandingReceipt,
    paymentMethod: method,
    paymentReference: reference || invoice.payment_history?.[invoice.payment_history.length - 1]?.reference,
    sourceModule: invoice.admission_id ? 'IPD' : 'Billing',
    sourceId: bill?._id || invoice._id,
    status: 'POSTED',
    remarks: remarks || `Legacy bill payment synchronised for invoice ${invoice.invoice_number || invoice._id}`,
    createdBy: user?._id,
    metadata: { legacyBillingBridge: true, invoiceNumber: invoice.invoice_number }
  });

  if (!invoice.receipt_numbers?.includes(receiptNumber)) {
    invoice.receipt_numbers = Array.from(new Set([...(invoice.receipt_numbers || []), receiptNumber]));
    await invoice.save();
  }

  return transaction;
}

function makeChargeLineKey(billId, itemIndex, sourceId) {
  return `${billId}:line:${itemIndex}:${sourceId || 'manual'}`;
}

module.exports = {
  syncLegacyInvoiceReceipt,
  makeChargeLineKey
};
