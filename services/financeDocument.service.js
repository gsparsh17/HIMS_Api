const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const FinancialTransaction = require('../models/FinancialTransaction');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const {
  canonicalInvoiceLines,
  invoiceLineTotals,
  expectedInvoiceBalance,
  transactionAppliedAmount,
  transactionExternalAmount,
  money,
  idOf
} = require('./financeInvariant.service');


async function resolveEncounterSnapshot(invoice, hospitalId) {
  if (!invoice) return null;

  const snapshot = { ...(invoice.encounter_snapshot || invoice.encounterSnapshot || {}) };
  const lines = Array.isArray(invoice.service_items) ? invoice.service_items : [];
  const sourceSnapshots = lines.map((line) => line?.source_snapshot || line?.sourceSnapshot || {}).filter(Boolean);
  const policyContexts = sourceSnapshots
    .map((source) => source?.financialPolicy?.context || source?.financial_policy?.context || null)
    .filter(Boolean);

  const firstSourceEncounter = sourceSnapshots.find((source) => source?.encounterSnapshot || source?.encounter_snapshot);
  const sourceEncounter = firstSourceEncounter?.encounterSnapshot || firstSourceEncounter?.encounter_snapshot || {};
  const firstPolicyContext = policyContexts[0] || {};

  const doctorId = snapshot.doctorId || snapshot.doctor_id || sourceEncounter.doctorId || sourceEncounter.doctor_id || null;
  const departmentId = snapshot.departmentId || snapshot.department_id || sourceEncounter.departmentId || sourceEncounter.department_id || firstPolicyContext.departmentId || firstPolicyContext.department_id || null;

  let doctorName = snapshot.doctorName || snapshot.doctor_name || sourceEncounter.doctorName || sourceEncounter.doctor_name || '';
  let departmentName = snapshot.departmentName || snapshot.department_name || sourceEncounter.departmentName || sourceEncounter.department_name || '';
  let departmentCode = snapshot.departmentCode || snapshot.department_code || sourceEncounter.departmentCode || sourceEncounter.department_code || '';

  if (!doctorName && doctorId && mongoose.Types.ObjectId.isValid(doctorId)) {
    const doctor = await Doctor.findOne({ _id: doctorId, hospitalId, is_deleted: { $ne: true } })
      .select('firstName lastName name')
      .lean();
    if (doctor) {
      const rawName = doctor.name || [doctor.firstName, doctor.lastName].filter(Boolean).join(' ');
      doctorName = rawName ? (String(rawName).trim().toLowerCase().startsWith('dr') ? String(rawName).trim() : `Dr. ${String(rawName).trim()}`) : '';
    }
  }

  if ((!departmentName || !departmentCode) && departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
    const department = await Department.findOne({ _id: departmentId, hospitalId, is_deleted: { $ne: true } })
      .select('name code')
      .lean();
    if (department) {
      departmentName = departmentName || department.name || '';
      departmentCode = departmentCode || department.code || '';
    }
  }

  if (!Object.keys(snapshot).length && !doctorId && !departmentId && !doctorName && !departmentName) return null;

  return {
    ...snapshot,
    encounterType: snapshot.encounterType || snapshot.encounter_type || firstPolicyContext.encounterType || 'OPD',
    doctorId: doctorId || undefined,
    doctorName: doctorName || undefined,
    departmentId: departmentId || undefined,
    departmentName: departmentName || undefined,
    departmentCode: departmentCode || undefined
  };
}

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
  const encounterSnapshot = await resolveEncounterSnapshot(invoice, hospitalId);
  if (encounterSnapshot) invoice.encounter_snapshot = encounterSnapshot;
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
    encounterSnapshot: encounterSnapshot || null,
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
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone dob dobPrecision ageEntrySource enteredAgeYears enteredAgeMonths enteredAgeDays ageAsOf age gender address city state zipCode village district tehsil emergency_contact emergency_phone emergency_relationship')
    .populate({
      path: 'invoiceId',
      select: 'invoice_number invoice_type total amount_paid balance_due status patient_snapshot hospital_snapshot admission_snapshot encounter_snapshot appointment_id admission_id doctor_id doctorName doctor_name settlement_discount_amount line_discount_total bill_discount_total discount gross_amount subtotal tax rounding_adjustment service_items',
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
          select: 'admissionNumber admissionDate dischargeDate dischargeType admissionType status wardId bedId roomId primaryDoctorId departmentId',
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
      select: 'admissionNumber admissionDate dischargeDate dischargeType admissionType status wardId bedId roomId primaryDoctorId departmentId',
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

  const encounterSnapshot = transaction.invoiceId
    ? await resolveEncounterSnapshot(transaction.invoiceId, hospitalId)
    : null;
  if (encounterSnapshot && transaction.invoiceId) transaction.invoiceId.encounter_snapshot = encounterSnapshot;

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
    encounterSnapshot: encounterSnapshot || null,
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
