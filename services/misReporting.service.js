const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const IPDAdmission = require('../models/IPDAdmission');
const { money } = require('../utils/financeNumbers');
const { transactionExternalAmount, transactionAppliedAmount } = require('./financeInvariant.service');

const REVENUE_EXCLUDED_TYPES = ['IPD Payment', 'IPD Advance Credit', 'Pharmacy Advance Credit', 'Credit Note'];

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function resolveDateRange(query = {}) {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: startOfDay(query.dateFrom || defaultStart),
    to: endOfDay(query.dateTo || now)
  };
}

function tenantCondition(hospitalId, field = 'hospital_id') {
  // Finance/MIS must never pull unscoped historic rows into an arbitrary tenant.
  // Legacy null hospital rows are surfaced by reconciliation and should be repaired
  // explicitly rather than silently included in every hospital's revenue.
  return hospitalId ? { [field]: hospitalId } : {};
}

function issuedInvoiceFilter({ from, to, hospitalId, invoiceType, patientId, admissionId } = {}) {
  const filter = {
    issue_date: { $gte: from, $lte: to },
    invoice_type: { $nin: REVENUE_EXCLUDED_TYPES },
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Draft'] },
    document_stage: { $ne: 'VOID' },
    // IPD-consolidated Pharmacy invoices are sub-ledger documents. The same
    // patient liability is recognised on the IPD invoice, so generic hospital
    // revenue/MIS must not count the Pharmacy document a second time.
    $nor: [
      { invoice_type: 'Pharmacy', collection_owner: 'IPD' },
      { invoice_type: 'Pharmacy', collection_mode: 'IPD_CONSOLIDATED' },
      { invoice_type: 'Pharmacy', collection_transferred_to_ipd: true }
    ],
    ...tenantCondition(hospitalId)
  };
  if (invoiceType) filter.invoice_type = invoiceType;
  if (patientId) filter.patient_id = patientId;
  if (admissionId) filter.admission_id = admissionId;
  return filter;
}

function transactionFilter({ from, to, hospitalId, admissionId, patientId } = {}) {
  const filter = {
    $or: [
      { postedAt: { $gte: from, $lte: to } },
      { postedAt: { $exists: false }, createdAt: { $gte: from, $lte: to } }
    ],
    status: 'POSTED',
    ...tenantCondition(hospitalId, 'hospitalId')
  };
  if (admissionId) filter.admissionId = admissionId;
  if (patientId) filter.patientId = patientId;
  return filter;
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function rowDate(value) {
  return new Date(value).toLocaleDateString('en-IN');
}

function totalOf(rows, field) {
  return money(rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0));
}

function groupRows(rows, keyFn, valueFn) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = keyFn(row) || 'Unassigned';
    const previous = groups.get(key) || { key, count: 0, gross: 0, discount: 0, tax: 0, billed: 0, credits: 0, netRevenue: 0, outstanding: 0, collected: 0, refunds: 0 };
    const values = valueFn(row);
    previous.count += values.count || 0;
    Object.keys(values).forEach((field) => {
      if (field !== 'count') previous[field] = money((previous[field] || 0) + (Number(values[field]) || 0));
    });
    groups.set(key, previous);
  });
  return [...groups.values()].sort((left, right) => right.netRevenue - left.netRevenue || right.collected - left.collected);
}

function invoicePayerValues(invoice = {}) {
  const allocation = invoice.payer_allocation || {};
  const hasCoverage = Boolean(allocation.coverage_id || allocation.payer_id);
  const sponsorLiability = money(allocation.sponsor_liability || 0);
  const sponsorPaid = money(allocation.sponsor_paid_amount || 0);
  const sponsorCredit = money(allocation.sponsor_credit_amount || 0);
  const patientLiability = hasCoverage
    ? money(allocation.patient_liability || 0)
    : money(invoice.total || 0);
  return {
    patientLiability,
    sponsorLiability,
    sponsorPaid,
    sponsorCredit,
    sponsorOutstanding: money(Math.max(0, sponsorLiability - sponsorPaid - sponsorCredit)),
    patientOutstanding: money(invoice.balance_due || 0),
    sponsored: hasCoverage && sponsorLiability > 0
  };
}

function invoiceRevenueValues(invoice) {
  const billed = money(invoice.total);
  const credits = money(invoice.credit_note_total || 0);
  const payer = invoicePayerValues(invoice);
  return {
    count: 1,
    gross: money(invoice.gross_amount ?? invoice.subtotal ?? invoice.total),
    discount: money(invoice.discount),
    tax: money(invoice.tax),
    billed,
    credits,
    netRevenue: money(billed - credits),
    outstanding: money(invoice.balance_due),
    patientBilled: payer.patientLiability,
    sponsorBilled: payer.sponsorLiability,
    patientOutstanding: payer.patientOutstanding,
    sponsorOutstanding: payer.sponsorOutstanding,
    sponsorPaid: payer.sponsorPaid
  };
}

function transactionValues(transaction) {
  const kind = String(transaction.transactionType || '').toUpperCase();
  const externalAmount = transactionExternalAmount(transaction);
  return {
    count: 1,
    collected: kind === 'RECEIPT' ? externalAmount : 0,
    advanceReceived: kind === 'ADVANCE_DEPOSIT' ? externalAmount : 0,
    advanceUtilised: kind === 'ADVANCE_UTILISATION' ? transactionAppliedAmount(transaction) : 0,
    refunds: ['REFUND', 'ADVANCE_REFUND'].includes(kind) && transaction.direction === 'DEBIT' ? money(transaction.amount) : 0
  };
}

async function loadReportingData(query = {}, user) {
  const { from, to } = resolveDateRange(query);
  const hospitalId = query.hospitalId || user?.hospital_id;
  const invoiceFilter = issuedInvoiceFilter({ ...query, from, to, hospitalId });
  const [invoices, transactions] = await Promise.all([
    Invoice.find(invoiceFilter)
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate({ path: 'admission_id', select: 'admissionNumber departmentId primaryDoctorId paymentType sponsorType sponsorName', populate: [{ path: 'departmentId', select: 'name' }, { path: 'primaryDoctorId', select: 'firstName lastName name' }] })
      .sort({ issue_date: -1, created_at: -1 })
      .lean(),
    FinancialTransaction.find(transactionFilter({ from, to, hospitalId, admissionId: query.admissionId, patientId: query.patientId }))
      .populate('patientId', 'first_name last_name patientId')
      .populate('invoiceId', 'invoice_number invoice_type')
      .sort({ createdAt: -1 })
      .lean()
  ]);
  return { from, to, hospitalId, invoices, transactions };
}

function overviewFromData(data) {
  const { invoices, transactions } = data;
  const grossRevenue = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0));
  const grossBilled = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.gross_amount ?? invoice.subtotal ?? invoice.total) || 0), 0));
  const discounts = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.discount) || 0), 0));
  const tax = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.tax) || 0), 0));
  const credits = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.credit_note_total) || 0), 0));
  const netRevenue = money(grossRevenue - credits);
  const receipts = transactions.filter((transaction) => String(transaction.transactionType || '').toUpperCase() === 'RECEIPT' && transaction.direction === 'CREDIT');
  const advances = transactions.filter((transaction) => String(transaction.transactionType || '').toUpperCase() === 'ADVANCE_DEPOSIT' && transaction.direction === 'CREDIT');
  const advanceUtilised = transactions.filter((transaction) => String(transaction.transactionType || '').toUpperCase() === 'ADVANCE_UTILISATION' && transaction.direction === 'CREDIT');
  const refunds = transactions.filter((transaction) => ['REFUND', 'ADVANCE_REFUND'].includes(String(transaction.transactionType || '').toUpperCase()) && transaction.direction === 'DEBIT');
  const collection = money(receipts.reduce((sum, item) => sum + transactionExternalAmount(item), 0));
  const advancesReceived = money(advances.reduce((sum, item) => sum + transactionExternalAmount(item), 0));
  const refundsTotal = money(refunds.reduce((sum, item) => sum + item.amount, 0));
  const netCollection = money(collection + advancesReceived - refundsTotal);
  const outstanding = money(invoices.reduce((sum, invoice) => sum + (Number(invoice.balance_due) || 0), 0));
  const payerTotals = invoices.reduce((totals, invoice) => {
    const payer = invoicePayerValues(invoice);
    totals.patientBilled = money(totals.patientBilled + payer.patientLiability);
    totals.sponsorBilled = money(totals.sponsorBilled + payer.sponsorLiability);
    totals.patientOutstanding = money(totals.patientOutstanding + payer.patientOutstanding);
    totals.sponsorOutstanding = money(totals.sponsorOutstanding + payer.sponsorOutstanding);
    totals.sponsorPaid = money(totals.sponsorPaid + payer.sponsorPaid);
    if (payer.sponsored) totals.sponsoredInvoiceCount += 1;
    return totals;
  }, { patientBilled: 0, sponsorBilled: 0, patientOutstanding: 0, sponsorOutstanding: 0, sponsorPaid: 0, sponsoredInvoiceCount: 0 });

  const dailyRows = groupRows(invoices, (invoice) => isoDay(invoice.issue_date), invoiceRevenueValues)
    .map((row) => ({ ...row, date: row.key }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const byInvoiceType = groupRows(invoices, (invoice) => invoice.invoice_type, invoiceRevenueValues)
    .map((row) => ({ ...row, type: row.key }));

  return {
    range: { dateFrom: data.from, dateTo: data.to },
    summary: {
      grossBilled,
      grossRevenue,
      discounts,
      tax,
      creditNotes: credits,
      netRevenue,
      collection,
      advancesReceived,
      advanceUtilised: money(advanceUtilised.reduce((sum, item) => sum + transactionAppliedAmount(item), 0)),
      refunds: refundsTotal,
      netCollection,
      netCashCollection: netCollection,
      outstanding,
      patientBilled: payerTotals.patientBilled,
      sponsorBilled: payerTotals.sponsorBilled,
      patientOutstanding: payerTotals.patientOutstanding,
      sponsorOutstanding: payerTotals.sponsorOutstanding,
      sponsorPaid: payerTotals.sponsorPaid,
      sponsoredInvoiceCount: payerTotals.sponsoredInvoiceCount,
      invoiceCount: invoices.length,
      receiptCount: receipts.length,
      averageInvoiceValue: invoices.length ? money(grossRevenue / invoices.length) : 0
    },
    charts: { dailyRows, byInvoiceType }
  };
}

async function getMISOverview(query, user) {
  const data = await loadReportingData(query, user);
  return overviewFromData(data);
}

function invoiceRegisterRows(invoices) {
  return invoices.map((invoice) => ({
    date: rowDate(invoice.issue_date),
    invoiceNumber: invoice.invoice_number,
    type: invoice.invoice_type,
    patient: invoice.patient_id ? `${invoice.patient_id.first_name || ''} ${invoice.patient_id.last_name || ''}`.trim() || invoice.patient_id.patientId : 'Walk-in',
    uhid: invoice.patient_id?.patientId || '',
    admissionNumber: invoice.admission_id?.admissionNumber || '',
    gross: money(invoice.gross_amount ?? invoice.subtotal ?? invoice.total),
    discount: money(invoice.discount),
    tax: money(invoice.tax),
    total: money(invoice.total),
    creditNotes: money(invoice.credit_note_total),
    paid: money(invoice.amount_paid),
    due: money(invoice.balance_due),
    patientLiability: invoicePayerValues(invoice).patientLiability,
    sponsorLiability: invoicePayerValues(invoice).sponsorLiability,
    sponsorPaid: invoicePayerValues(invoice).sponsorPaid,
    sponsorDue: invoicePayerValues(invoice).sponsorOutstanding,
    status: invoice.status
  }));
}

function collectionRows(transactions) {
  return transactions
    .filter((transaction) => ['RECEIPT', 'ADVANCE_DEPOSIT', 'ADVANCE_UTILISATION', 'SETTLEMENT', 'CREDIT_NOTE', 'REFUND', 'ADVANCE_REFUND'].includes(String(transaction.transactionType || '').toUpperCase()))
    .map((transaction) => {
      const type = String(transaction.transactionType || '').toUpperCase();
      const external = transactionExternalAmount(transaction);
      const applied = transactionAppliedAmount(transaction);
      const isRefund = ['REFUND', 'ADVANCE_REFUND'].includes(type) && transaction.direction === 'DEBIT';
      return {
        date: rowDate(transaction.postedAt || transaction.createdAt),
        receiptNumber: transaction.transactionNumber,
        type: transaction.transactionType,
        patient: transaction.patientId ? `${transaction.patientId.first_name || ''} ${transaction.patientId.last_name || ''}`.trim() || transaction.patientId.patientId : '',
        invoiceNumber: transaction.invoiceId?.invoice_number || '',
        paymentMethod: transaction.paymentMethod,
        reference: transaction.paymentReference || '',
        externalReceived: external,
        applied,
        credit: !isRefund ? external : 0,
        debit: isRefund ? money(transaction.amount) : 0,
        status: transaction.status
      };
    });
}

async function getMISReport(reportKey, query, user) {
  const data = await loadReportingData(query, user);
  const overview = overviewFromData(data);
  const { invoices, transactions } = data;
  let columns = [];
  let rows = [];
  let title = 'MIS Report';

  switch (reportKey) {
    case 'revenue':
      title = 'Revenue Summary';
      columns = ['date', 'gross', 'discount', 'tax', 'billed', 'credits', 'netRevenue', 'outstanding'];
      rows = overview.charts.dailyRows.map((row) => ({ date: row.date, gross: row.gross, discount: row.discount, tax: row.tax, billed: row.billed, credits: row.credits, netRevenue: row.netRevenue, outstanding: row.outstanding }));
      break;
    case 'collections':
      title = 'Collection Register';
      columns = ['date', 'receiptNumber', 'type', 'patient', 'invoiceNumber', 'paymentMethod', 'reference', 'externalReceived', 'applied', 'credit', 'debit', 'status'];
      rows = collectionRows(transactions);
      break;
    case 'outstanding':
      title = 'Outstanding Invoice Report';
      columns = ['date', 'invoiceNumber', 'type', 'patient', 'uhid', 'admissionNumber', 'total', 'paid', 'due', 'status'];
      rows = invoiceRegisterRows(invoices).filter((row) => row.due > 0);
      break;
    case 'invoice-register':
      title = 'Invoice Register';
      columns = ['date', 'invoiceNumber', 'type', 'patient', 'uhid', 'admissionNumber', 'gross', 'discount', 'tax', 'total', 'patientLiability', 'sponsorLiability', 'sponsorPaid', 'sponsorDue', 'creditNotes', 'paid', 'due', 'status'];
      rows = invoiceRegisterRows(invoices);
      break;
    case 'discounts-refunds':
      title = 'Discount, Credit Note & Refund Report';
      columns = ['date', 'invoiceNumber', 'patient', 'type', 'discount', 'creditNotes', 'refunds', 'status'];
      rows = invoiceRegisterRows(invoices)
        .filter((row) => row.discount > 0 || row.creditNotes > 0)
        .map((row) => ({ ...row, refunds: 0 }));
      const refundByInvoice = transactions.filter((transaction) => transaction.transactionType === 'REFUND').reduce((map, transaction) => {
        const key = String(transaction.invoiceId?._id || transaction.invoiceId || '');
        map.set(key, money((map.get(key) || 0) + transaction.amount));
        return map;
      }, new Map());
      rows.forEach((row) => {
        const invoice = invoices.find((entry) => entry.invoice_number === row.invoiceNumber);
        row.refunds = money(refundByInvoice.get(String(invoice?._id)) || 0);
      });
      break;
    case 'department':
      title = 'Department-wise Revenue';
      columns = ['department', 'count', 'gross', 'discount', 'credits', 'netRevenue', 'outstanding'];
      rows = groupRows(invoices, (invoice) => invoice.encounter_snapshot?.departmentName || invoice.encounter_snapshot?.department || invoice.admission_id?.departmentId?.name || (invoice.invoice_type === 'Pharmacy' ? 'Pharmacy' : 'OPD / Unassigned'), invoiceRevenueValues)
        .map((row) => ({ department: row.key, ...row }));
      break;
    case 'doctor':
      title = 'Doctor-wise Revenue';
      columns = ['doctor', 'count', 'gross', 'discount', 'credits', 'netRevenue', 'outstanding'];
      rows = groupRows(invoices, (invoice) => {
        const snapshotName = invoice.encounter_snapshot?.doctorName || invoice.encounter_snapshot?.consultantName;
        if (snapshotName) return /^dr\.?\s/i.test(snapshotName) ? snapshotName : `Dr. ${snapshotName}`;
        const doctor = invoice.admission_id?.primaryDoctorId;
        return doctor ? `Dr. ${doctor.firstName || doctor.name || ''} ${doctor.lastName || ''}`.trim() : 'Unassigned';
      }, invoiceRevenueValues).map((row) => ({ doctor: row.key, ...row }));
      break;
    case 'ipd':
      title = 'IPD Billing & Clearance Report';
      columns = ['admissionNumber', 'patient', 'total', 'paid', 'due', 'advanceAvailable', 'financialClearanceStatus', 'status'];
      const admissions = await IPDAdmission.find({
        ...(query.admissionId ? { _id: query.admissionId } : {}),
        ...(user?.hospital_id ? tenantCondition(user.hospital_id, 'hospitalId') : {})
      }).populate('patientId', 'first_name last_name patientId').sort({ admissionDate: -1 }).lean();
      rows = admissions.map((admission) => ({
        admissionNumber: admission.admissionNumber,
        patient: `${admission.patientId?.first_name || ''} ${admission.patientId?.last_name || ''}`.trim(),
        total: money(admission.totalBillAmount),
        paid: money(admission.paidAmount),
        due: money(admission.dueAmount),
        advanceAvailable: money(admission.advanceAmount),
        financialClearanceStatus: admission.financialClearanceStatus || 'pending',
        status: admission.status
      }));
      break;
    case 'advance-ledger':
      title = 'IPD Advance Ledger';
      columns = ['date', 'admissionNumber', 'patient', 'transactionType', 'direction', 'amount', 'openingBalance', 'balanceAfter', 'referenceNumber', 'paymentMethod'];
      const advanceFilter = {
        createdAt: { $gte: data.from, $lte: data.to },
        ...(user?.hospital_id ? tenantCondition(user.hospital_id, 'hospitalId') : {})
      };
      const advanceRows = await PatientAdvanceLedger.find(advanceFilter)
        .populate('patientId', 'first_name last_name patientId')
        .populate('admissionId', 'admissionNumber')
        .sort({ createdAt: -1 })
        .lean();
      rows = advanceRows.map((entry) => ({
        date: rowDate(entry.createdAt),
        admissionNumber: entry.admissionId?.admissionNumber || '',
        patient: `${entry.patientId?.first_name || ''} ${entry.patientId?.last_name || ''}`.trim(),
        transactionType: entry.transactionType,
        direction: entry.direction,
        amount: money(entry.amount),
        openingBalance: money(entry.openingBalance),
        balanceAfter: money(entry.balanceAfter),
        referenceNumber: entry.referenceNumber || '',
        paymentMethod: entry.paymentMethod
      }));
      break;
    default:
      const error = new Error(`Unsupported MIS report: ${reportKey}`);
      error.statusCode = 400;
      throw error;
  }

  return { title, reportKey, range: overview.range, summary: overview.summary, columns, rows };
}

module.exports = { resolveDateRange, getMISOverview, getMISReport };
