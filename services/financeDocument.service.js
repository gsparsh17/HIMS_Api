const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const FinancialTransaction = require('../models/FinancialTransaction');
const {
  canonicalInvoiceLines,
  invoiceLineTotals,
  expectedInvoiceBalance,
  transactionAppliedAmount,
  transactionExternalAmount,
  money,
  idOf
} = require('./financeInvariant.service');

async function invoicePrintEnvelope({ invoiceId, hospitalId }) {
  const invoice = await Invoice.findOne({ _id: invoiceId, hospital_id: hospitalId, is_deleted: { $ne: true } })
    .populate('patient_id')
    .populate({
      path: 'appointment_id',
      populate: [
        { path: 'doctor_id', select: 'firstName lastName specialization phone department' },
        { path: 'department_id', select: 'name code' }
      ]
    })
    .populate({
      path: 'admission_id',
      populate: [
        { path: 'primaryDoctorId', select: 'firstName lastName specialization' },
        { path: 'departmentId', select: 'name code' },
        { path: 'wardId', select: 'name wardNumber' },
        { path: 'bedId', select: 'bedNumber roomNumber' }
      ]
    })
    .populate('bill_id', '_id bill_number')
    .populate('bill_ids', '_id bill_number')
    .lean();

  if (!invoice) return null;
  const lines = canonicalInvoiceLines(invoice);
  const lineTotals = invoiceLineTotals(invoice);
  const transactions = await FinancialTransaction.find({
    hospitalId,
    patientId: invoice.patient_id?._id || invoice.patient_id,
    status: 'POSTED',
    $or: [
      { invoiceId: invoice._id },
      { documentAllocations: { $elemMatch: { documentType: 'Invoice', documentId: invoice._id } } }
    ]
  }).sort({ postedAt: 1, createdAt: 1 }).lean();

  return {
    documentType: 'INVOICE',
    documentId: invoice._id,
    documentNumber: invoice.invoice_number,
    invoice,
    patient: invoice.patient_id,
    appointment: invoice.appointment_id || null,
    admission: invoice.admission_id || null,
    lines,
    amounts: {
      gross: Number(invoice.gross_amount ?? invoice.subtotal ?? 0),
      lineDiscount: Number(invoice.line_discount_total || 0),
      billDiscount: Number(invoice.bill_discount_total || 0),
      discount: Number(invoice.discount || 0),
      taxable: Number(invoice.taxable_amount ?? 0),
      tax: Number(invoice.tax || 0),
      rounding: Number(invoice.rounding_adjustment || 0),
      total: Number(invoice.total || 0),
      amountPaid: Number(invoice.amount_paid || 0),
      settlementDiscount: Number(invoice.settlement_discount_amount || 0),
      creditNotes: Number(invoice.credit_note_total || 0),
      refunded: Number(invoice.refunded_amount || 0),
      balanceDue: Number(invoice.balance_due || 0)
    },
    integrity: {
      lineCount: lineTotals.count,
      lineNetTotal: lineTotals.net,
      invoiceTotal: money(invoice.total),
      lineTotalMatches: Math.abs(lineTotals.net - money(invoice.total)) <= 0.02,
      expectedBalance: expectedInvoiceBalance(invoice),
      balanceMatches: Math.abs(expectedInvoiceBalance(invoice) - money(invoice.balance_due)) <= 0.02
    },
    transactions,
    billRefs: [invoice.bill_id, ...(invoice.bill_ids || [])].filter(Boolean)
  };
}

async function transactionPrintEnvelope({ transactionIdOrNumber, hospitalId }) {
  const selector = mongoose.Types.ObjectId.isValid(transactionIdOrNumber)
    ? { $or: [{ _id: transactionIdOrNumber }, { transactionNumber: String(transactionIdOrNumber).toUpperCase() }] }
    : { transactionNumber: String(transactionIdOrNumber || '').toUpperCase() };

  const transaction = await FinancialTransaction.findOne({
    hospitalId,
    status: { $in: ['POSTED', 'REVERSED'] },
    ...selector
  })
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone dob gender')
    .populate({
      path: 'invoiceId',
      select: 'invoice_number invoice_type total amount_paid balance_due status patient_snapshot hospital_snapshot admission_snapshot appointment_id admission_id doctor_id doctorName doctor_name',
      populate: [
        {
          path: 'appointment_id',
          select: 'appointment_id doctor_id department_id appointment_date',
          populate: [
            { path: 'doctor_id', select: 'firstName lastName specialization phone department' },
            { path: 'department_id', select: 'name code' }
          ]
        },
        {
          path: 'admission_id',
          select: 'admissionNumber admissionDate status wardId bedId roomId primaryDoctorId departmentId',
          populate: [
            { path: 'primaryDoctorId', select: 'firstName lastName specialization' },
            { path: 'departmentId', select: 'name code' },
            { path: 'wardId', select: 'name wardNumber' },
            { path: 'bedId', select: 'bedNumber roomNumber' }
          ]
        }
      ]
    })
    .populate('billId', 'bill_number total_amount paid_amount balance_due status')
    .populate({
      path: 'admissionId',
      select: 'admissionNumber admissionDate status wardId bedId roomId primaryDoctorId departmentId',
      populate: [
        { path: 'primaryDoctorId', select: 'firstName lastName specialization' },
        { path: 'departmentId', select: 'name code' },
        { path: 'wardId', select: 'name wardNumber' },
        { path: 'bedId', select: 'bedNumber roomNumber' }
      ]
    })
    .populate('createdBy', 'name firstName lastName email')
    .lean();

  if (!transaction) return null;

  const allocationRows = [];
  const invoiceAllocationIds = (transaction.documentAllocations || []).filter((row) => row.documentType === 'Invoice').map((row) => row.documentId).filter(Boolean);
  const billAllocationIds = (transaction.documentAllocations || []).filter((row) => row.documentType === 'Bill').map((row) => row.documentId).filter(Boolean);
  const [allocationInvoices, allocationBills] = await Promise.all([
    invoiceAllocationIds.length ? Invoice.find({ _id: { $in: invoiceAllocationIds }, hospital_id: hospitalId }).select('invoice_number invoice_type total balance_due status').lean() : [],
    billAllocationIds.length ? Bill.find({ _id: { $in: billAllocationIds }, hospital_id: hospitalId }).select('bill_number total_amount balance_due status').lean() : []
  ]);
  const invoiceMap = new Map(allocationInvoices.map((row) => [idOf(row._id), row]));
  const billMap = new Map(allocationBills.map((row) => [idOf(row._id), row]));
  for (const allocation of transaction.documentAllocations || []) {
    const document = allocation.documentType === 'Invoice'
      ? invoiceMap.get(idOf(allocation.documentId))
      : billMap.get(idOf(allocation.documentId));
    allocationRows.push({
      documentType: allocation.documentType,
      documentId: allocation.documentId,
      documentNumber: document?.invoice_number || document?.bill_number || idOf(allocation.documentId),
      amount: money(allocation.amount),
      status: document?.status,
      balanceDue: money(document?.balance_due)
    });
  }

  const adjustmentDocumentId = transaction.metadata?.creditNoteId || transaction.metadata?.creditNoteInvoiceId || transaction.sourceId;
  const adjustmentDocument = adjustmentDocumentId && ['REFUND', 'CREDIT_NOTE'].includes(String(transaction.transactionType || '').toUpperCase())
    ? await Invoice.findOne({ _id: adjustmentDocumentId, hospital_id: hospitalId }).select('invoice_number invoice_type document_stage total linked_invoice_id notes').lean()
    : null;

  return {
    documentType: String(transaction.transactionType || 'TRANSACTION').toUpperCase(),
    documentId: transaction._id,
    documentNumber: transaction.transactionNumber,
    transaction,
    patient: transaction.patientId || null,
    invoice: transaction.invoiceId || null,
    bill: transaction.billId || null,
    admission: transaction.admissionId || null,
    adjustmentDocument,
    allocations: allocationRows,
    amounts: {
      transactionAmount: money(transaction.amount),
      externalReceived: transactionExternalAmount(transaction),
      amountApplied: transactionAppliedAmount(transaction),
      amountTendered: money(transaction.amountTendered),
      changeReturned: money(transaction.changeReturned),
      advanceCreated: money(transaction.advanceCreated),
      advanceApplied: money(transaction.advanceApplied),
      settlementDiscount: money(transaction.settlementDiscountAmount),
      refundAmount: ['REFUND', 'ADVANCE_REFUND'].includes(String(transaction.transactionType || '').toUpperCase()) ? money(transaction.amount) : 0,
      balanceAfter: money(transaction.balanceAfter)
    },
    integrity: {
      allocationTotal: money((transaction.documentAllocations || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      allocationMatchesTransaction: !(transaction.documentAllocations || []).length || Math.abs(money((transaction.documentAllocations || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)) - money(transaction.amount)) <= 0.02
    }
  };
}

module.exports = { invoicePrintEnvelope, transactionPrintEnvelope };
