const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const IPDCharge = require('../models/IPDCharge');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const EXCLUDED_INVOICE_TYPES = ['IPD Payment', 'IPD Advance Credit', 'Pharmacy Advance Credit', 'Credit Note'];

function hospitalFilter(hospitalId, field) {
  return hospitalId ? { [field]: hospitalId } : {};
}

function parseHospitalRange(query = {}) {
  const timezone = query.timezone || 'Asia/Kolkata';
  const offsetMinutes = timezone === 'Asia/Kolkata' ? 330 : 0;
  const now = new Date();
  const fromText = query.from || query.startDate || query.dateFrom || now.toISOString().slice(0, 10);
  const toText = query.to || query.endDate || query.dateTo || fromText;
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T23:59:59.999Z`);
  from.setUTCMinutes(from.getUTCMinutes() - offsetMinutes);
  to.setUTCMinutes(to.getUTCMinutes() - offsetMinutes);
  return { from, to, timezone, fromDate: fromText, toDate: toText };
}

function invoiceEncounterSource(invoice) {
  if (invoice.is_pharmacy_sale || /pharmacy/i.test(invoice.invoice_type || '')) return 'Pharmacy';
  if (invoice.admission_id || invoice.patient_type === 'IPD') return 'IPD';
  if (invoice.patient_type === 'Emergency') return 'Emergency';
  return 'OPD';
}

function invoiceServiceSource(invoice) {
  const type = String(invoice.invoice_type || invoice.type || '').toLowerCase();
  if (type.includes('lab')) return 'Lab';
  if (type.includes('radiology') || type.includes('imaging') || type.includes('x-ray')) return 'Radiology';
  if (type.includes('procedure') || type.includes('surgery') || type.includes('ot')) return 'Procedure';
  if (type.includes('appointment') || type.includes('consult')) return 'Appointment';
  if (type.includes('bed') || type.includes('room')) return 'Bed';
  if (type.includes('pharmacy')) return 'Pharmacy';
  return invoiceEncounterSource(invoice);
}

function textId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value._id || value.id || value);
}

function snapshotName(value, fallback = 'Unknown') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  return value.name || value.fullName || [value.firstName, value.lastName].filter(Boolean).join(' ') || fallback;
}

function doctorMeta(invoice) {
  const raw = invoice.doctor_snapshot || invoice.doctor || invoice.doctor_id || invoice.consultant || invoice.consultant_id;
  return {
    id: textId(raw),
    name: snapshotName(raw, invoice.doctor_name || invoice.consultant_name || 'Unassigned'),
    commission: money(invoice.doctor_commission_snapshot?.amount ?? invoice.doctor_commission ?? invoice.commission ?? 0),
    commissionRate: Number(invoice.doctor_commission_snapshot?.percentage ?? invoice.commission_percentage ?? 0) || 0
  };
}

function departmentMeta(invoice) {
  const raw = invoice.department_snapshot || invoice.department || invoice.department_id;
  return {
    id: textId(raw),
    name: snapshotName(raw, invoice.department_name || 'Unassigned')
  };
}

function externalCredit(tx) {
  if (tx.status !== 'POSTED' || tx.direction !== 'CREDIT') return false;
  if (tx.externalMoneyMovement === false) return false;
  return ['RECEIPT', 'SETTLEMENT', 'ADVANCE_DEPOSIT'].includes(tx.transactionType);
}

function refundDebit(tx) {
  return tx.status === 'POSTED' && tx.direction === 'DEBIT' && ['REFUND', 'ADVANCE_REFUND'].includes(tx.transactionType);
}

function applyInvoiceFilters(invoices, query = {}) {
  return invoices.filter((invoice) => {
    const encounter = invoiceEncounterSource(invoice);
    const service = invoiceServiceSource(invoice);
    const doctor = doctorMeta(invoice);
    const department = departmentMeta(invoice);
    const total = Number(invoice.total || 0);
    if (query.patientType && query.patientType !== 'all' && encounter !== query.patientType) return false;
    if (query.encounterSource && query.encounterSource !== 'all' && encounter !== query.encounterSource) return false;
    if (query.serviceSource && query.serviceSource !== 'all' && service !== query.serviceSource) return false;
    if (query.invoiceType && query.invoiceType !== 'all' && invoice.invoice_type !== query.invoiceType) return false;
    if (query.status && query.status !== 'all' && invoice.status !== query.status) return false;
    if (query.doctorId && query.doctorId !== 'all' && doctor.id !== String(query.doctorId)) return false;
    if (query.departmentId && query.departmentId !== 'all' && department.id !== String(query.departmentId)) return false;
    if (query.minAmount && total < Number(query.minAmount)) return false;
    if (query.maxAmount && total > Number(query.maxAmount)) return false;
    return true;
  });
}

function applyTransactionFilters(transactions, query = {}) {
  return transactions.filter((tx) => {
    if (query.paymentMethod && query.paymentMethod !== 'all' && tx.paymentMethod !== query.paymentMethod) return false;
    if (query.transactionType && query.transactionType !== 'all' && tx.transactionType !== query.transactionType) return false;
    return true;
  });
}

async function load({ query = {}, user = {} }) {
  const range = parseHospitalRange(query);
  const hospitalId = query.hospitalId || user.hospital_id || user.hospitalId;
  const [rawInvoices, rawTransactions, unbilledCharges] = await Promise.all([
    Invoice.find({
      ...hospitalFilter(hospitalId, 'hospital_id'),
      issue_date: { $gte: range.from, $lte: range.to },
      invoice_type: { $nin: EXCLUDED_INVOICE_TYPES },
      is_deleted: { $ne: true },
      status: { $nin: ['Cancelled', 'Draft'] },
      document_stage: { $ne: 'VOID' }
    }).lean(),
    FinancialTransaction.find({
      ...hospitalFilter(hospitalId, 'hospitalId'),
      $or: [
        { postedAt: { $gte: range.from, $lte: range.to } },
        { postedAt: { $exists: false }, createdAt: { $gte: range.from, $lte: range.to } }
      ],
      status: 'POSTED'
    }).lean(),
    IPDCharge.find({
      ...hospitalFilter(hospitalId, 'hospitalId'),
      serviceDate: { $gte: range.from, $lte: range.to },
      status: { $in: ['ACTIVE', 'UNBILLED'] },
      $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }]
    }).lean()
  ]);
  return {
    range,
    hospitalId,
    invoices: applyInvoiceFilters(rawInvoices, query),
    transactions: applyTransactionFilters(rawTransactions, query),
    unbilledCharges
  };
}

function invoiceRow(invoice) {
  const doctor = doctorMeta(invoice);
  const department = departmentMeta(invoice);
  const gross = money(invoice.gross_amount ?? invoice.subtotal ?? invoice.total);
  const creditNotes = money(invoice.credit_note_total || 0);
  const netRevenue = money((invoice.total || 0) - creditNotes);
  return {
    id: invoice._id,
    date: invoice.issue_date,
    invoiceNumber: invoice.invoice_number,
    invoiceType: invoice.invoice_type,
    encounterSource: invoiceEncounterSource(invoice),
    serviceSource: invoiceServiceSource(invoice),
    patientId: textId(invoice.patient_id || invoice.patient),
    patientName: snapshotName(invoice.patient_snapshot || invoice.patient, invoice.patient_name || 'Unknown'),
    doctorId: doctor.id,
    doctorName: doctor.name,
    departmentId: department.id,
    departmentName: department.name,
    status: invoice.status,
    gross,
    discount: money(invoice.discount || invoice.discount_amount || 0),
    tax: money(invoice.tax || invoice.tax_amount || 0),
    creditNotes,
    netRevenue,
    amountPaid: money(invoice.amount_paid || invoice.paid_amount || 0),
    outstanding: money(invoice.balance_due || 0),
    doctorCommission: doctor.commission,
    commissionRate: doctor.commissionRate,
    hospitalShare: money(netRevenue - doctor.commission)
  };
}

function transactionRow(tx) {
  return {
    id: tx._id,
    postedAt: tx.postedAt || tx.createdAt,
    transactionNumber: tx.transactionNumber || tx.referenceNumber || '',
    transactionType: tx.transactionType,
    direction: tx.direction,
    paymentMethod: tx.paymentMethod || 'Unspecified',
    amount: money(tx.amount),
    amountTendered: money(tx.amountTendered ?? tx.amount),
    amountApplied: money(tx.amountApplied ?? tx.amount),
    changeReturned: money(tx.changeReturned || 0),
    advanceCreated: money(tx.advanceCreated || 0),
    externalMoneyMovement: tx.externalMoneyMovement !== false,
    patientId: textId(tx.patientId || tx.patient_id),
    invoiceId: textId(tx.invoiceId || tx.invoice_id),
    billId: textId(tx.billId || tx.bill_id),
    notes: tx.notes || tx.description || ''
  };
}

function sumRows(rows, key) {
  return money(rows.reduce((sum, row) => sum + Number(row[key] || 0), 0));
}

function group(rows, keyGetter, seedFactory, reducer) {
  return Object.values(rows.reduce((acc, row) => {
    const key = keyGetter(row) || 'Unknown';
    acc[key] ||= seedFactory(key);
    reducer(acc[key], row);
    return acc;
  }, {}));
}

function dayKey(date, timezone = 'Asia/Kolkata') {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date)); }
  catch (_) { return new Date(date).toISOString().slice(0, 10); }
}

function monthKey(date, timezone = 'Asia/Kolkata') {
  return dayKey(date, timezone).slice(0, 7);
}

function project(data) {
  const invoiceRows = data.invoices.map(invoiceRow);
  const allTransactions = data.transactions.map(transactionRow);
  const externalCredits = data.transactions.filter(externalCredit).map(transactionRow);
  const refunds = data.transactions.filter(refundDebit).map(transactionRow);
  const receipts = externalCredits.filter((tx) => ['RECEIPT', 'SETTLEMENT'].includes(tx.transactionType));
  const advances = externalCredits.filter((tx) => tx.transactionType === 'ADVANCE_DEPOSIT');
  const advanceUsed = allTransactions.filter((tx) => tx.transactionType === 'ADVANCE_UTILISATION');

  const summary = {
    grossBilled: sumRows(invoiceRows, 'gross'),
    discounts: sumRows(invoiceRows, 'discount'),
    tax: sumRows(invoiceRows, 'tax'),
    creditNotes: sumRows(invoiceRows, 'creditNotes'),
    netRevenue: sumRows(invoiceRows, 'netRevenue'),
    collections: sumRows(receipts, 'amount'),
    advancesReceived: sumRows(advances, 'amount'),
    advanceUtilised: sumRows(advanceUsed, 'amount'),
    refunds: sumRows(refunds, 'amount'),
    netCashCollection: money(sumRows(receipts, 'amount') + sumRows(advances, 'amount') - sumRows(refunds, 'amount')),
    outstanding: sumRows(invoiceRows, 'outstanding'),
    unbilledProduction: money(data.unbilledCharges.reduce((s, row) => s + Number(row.netAmount ?? row.totalAmount ?? row.amount ?? 0), 0)),
    invoiceCount: invoiceRows.length,
    receiptCount: receipts.length,
    averageInvoiceValue: invoiceRows.length ? money(sumRows(invoiceRows, 'netRevenue') / invoiceRows.length) : 0
  };

  const bySource = group(invoiceRows, (r) => r.encounterSource, (source) => ({ source, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  });
  const byService = group(invoiceRows, (r) => r.serviceSource, (service) => ({ service, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0, doctorCommission: 0, hospitalShare: 0 }), (a, r) => {
    a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.doctorCommission = money(a.doctorCommission + r.doctorCommission); a.hospitalShare = money(a.hospitalShare + r.hospitalShare); a.invoiceCount += 1;
  });
  const byDoctor = group(invoiceRows, (r) => r.doctorId || r.doctorName, (key) => ({ doctorId: '', doctorName: key, netRevenue: 0, doctorCommission: 0, hospitalShare: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.doctorId ||= r.doctorId; a.doctorName = r.doctorName; a.netRevenue = money(a.netRevenue + r.netRevenue); a.doctorCommission = money(a.doctorCommission + r.doctorCommission); a.hospitalShare = money(a.hospitalShare + r.hospitalShare); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  }).sort((a, b) => b.netRevenue - a.netRevenue);
  const byDepartment = group(invoiceRows, (r) => r.departmentId || r.departmentName, (key) => ({ departmentId: '', departmentName: key, netRevenue: 0, doctorCommission: 0, hospitalShare: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.departmentId ||= r.departmentId; a.departmentName = r.departmentName; a.netRevenue = money(a.netRevenue + r.netRevenue); a.doctorCommission = money(a.doctorCommission + r.doctorCommission); a.hospitalShare = money(a.hospitalShare + r.hospitalShare); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  }).sort((a, b) => b.netRevenue - a.netRevenue);
  const paymentMethods = group(externalCredits, (r) => r.paymentMethod, (paymentMethod) => ({ paymentMethod, amount: 0, count: 0 }), (a, r) => { a.amount = money(a.amount + r.amount); a.count += 1; }).sort((a, b) => b.amount - a.amount);
  const daily = group(invoiceRows, (r) => dayKey(r.date, data.range.timezone), (date) => ({ date, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => { a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1; }).sort((a, b) => a.date.localeCompare(b.date));
  const monthly = group(invoiceRows, (r) => monthKey(r.date, data.range.timezone), (month) => ({ month, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => { a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1; }).sort((a, b) => a.month.localeCompare(b.month));

  return { range: data.range, summary, bySource, byService, byDoctor, byDepartment, paymentMethods, daily, monthly, invoiceRows, transactionRows: allTransactions };
}

function paginate(rows, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(query.limit || 25)));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { rows: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total, totalPages } };
}

async function getKpis(query, user) {
  return project(await load({ query, user }));
}

async function getReport(reportKey, query, user) {
  const data = await load({ query, user });
  const projection = project(data);
  const common = { ...projection, reportKey };
  if (reportKey === 'revenue') return { ...common, rows: projection.invoiceRows };
  if (reportKey === 'collections') return { ...common, rows: projection.transactionRows.filter((r) => r.externalMoneyMovement || ['REFUND', 'ADVANCE_REFUND', 'ADVANCE_UTILISATION'].includes(r.transactionType)) };
  if (reportKey === 'unbilled') return { ...common, rows: data.unbilledCharges };
  if (reportKey === 'daily') return { ...common, rows: projection.daily };
  if (reportKey === 'monthly') return { ...common, rows: projection.monthly };
  if (reportKey === 'doctor') return { ...common, rows: projection.byDoctor };
  if (reportKey === 'department') return { ...common, rows: projection.byDepartment };
  if (reportKey === 'service') return { ...common, rows: projection.byService };
  if (reportKey === 'ipd') return { ...common, rows: projection.invoiceRows.filter((r) => r.encounterSource === 'IPD'), unbilledRows: data.unbilledCharges };
  if (reportKey === 'invoices') return { ...common, ...paginate(projection.invoiceRows, query) };
  if (reportKey === 'transactions') return { ...common, ...paginate(projection.transactionRows, query) };
  if (reportKey === 'reconciliation') {
    const anomalies = [];
    data.invoices.forEach((invoice) => {
      const expected = money((invoice.total || 0) - (invoice.amount_paid || 0) - (invoice.credit_note_total || 0));
      if (Math.abs(expected - money(invoice.balance_due || 0)) > 0.02) anomalies.push({ type: 'INVOICE_BALANCE_MISMATCH', invoiceId: invoice._id, invoiceNumber: invoice.invoice_number, expected, actual: money(invoice.balance_due || 0) });
    });
    return { ...common, rows: anomalies };
  }
  const error = new Error(`Unsupported finance report: ${reportKey}`);
  error.statusCode = 400;
  throw error;
}

module.exports = { parseHospitalRange, getKpis, getReport };
