const mongoose = require('mongoose');
const { requireHospitalId } = require('../services/tenantScope.service');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const MISMetricDefinition = require('../models/MISMetricDefinition');
const MISSnapshot = require('../models/MISSnapshot');
const MISExportJob = require('../models/MISExportJob');
const MISSchedule = require('../models/MISSchedule');

const REPORT_CATALOG = [
  { key: 'executive', label: 'Executive Hospital Overview', module: 'Executive', dimensions: ['day', 'department'], description: 'Admissions, discharges, visits, investigations, OT cases, revenue and occupancy.' },
  { key: 'ipd', label: 'IPD Census & Clinical Activity', module: 'IPD', dimensions: ['day', 'ward', 'doctor'], description: 'Admissions, discharges, length of stay, occupancy, mortality and clinical document completion.' },
  { key: 'opd', label: 'OPD & Appointment Activity', module: 'OPD', dimensions: ['day', 'department', 'doctor'], description: 'Booked, completed, cancelled and no-show appointments.' },
  { key: 'ot', label: 'Operation Theatre Performance', module: 'OT', dimensions: ['day', 'room', 'surgeon', 'procedure'], description: 'Requested, scheduled, completed, cancelled, utilisation, turnaround, delays and readiness.' },
  { key: 'store', label: 'Store & Inventory Control', module: 'Store', dimensions: ['item', 'category', 'location'], description: 'Stock value, movements, stock-outs, expiries, reservations, GRNs, returns and variances.' },
  { key: 'lab', label: 'Laboratory TAT & Workload', module: 'Laboratory', dimensions: ['day', 'test', 'department'], description: 'Requests, completed reports, pending work and turnaround time.' },
  { key: 'radiology', label: 'Radiology TAT & Workload', module: 'Radiology', dimensions: ['day', 'modality', 'department'], description: 'Requests, completed reports, pending work and turnaround time.' },
  { key: 'pharmacy', label: 'Pharmacy Activity', module: 'Pharmacy', dimensions: ['day', 'medicine'], description: 'Dispensing, returns, expiries, batches and consumption.' },
  { key: 'billing', label: 'Billing & Collection', module: 'Finance', dimensions: ['day', 'payer', 'department'], description: 'Invoices, gross billing, receipts, dues, discounts and refunds.' },
  { key: 'hr', label: 'HR & Payroll', module: 'HR', dimensions: ['department', 'designation'], description: 'Headcount, active staff, leave and payroll.' },
  { key: 'clinical-quality', label: 'Clinical Quality & Documentation', module: 'Quality', dimensions: ['document', 'department', 'doctor'], description: 'Consent, assessment, medication, discharge and signed-document completion.' }
];

function model(name) {
  try { return mongoose.model(name); } catch (_error) { return null; }
}

function dateFilter(field, start, end) {
  if (!start && !end) return {};
  const value = {};
  if (start) value.$gte = new Date(start);
  if (end) {
    const inclusive = new Date(end);
    inclusive.setHours(23, 59, 59, 999);
    value.$lte = inclusive;
  }
  return { [field]: value };
}

async function count(name, filter) {
  const Model = model(name);
  return Model ? Model.countDocuments(filter) : 0;
}

async function sum(name, filter, field) {
  const Model = model(name);
  if (!Model) return 0;
  const result = await Model.aggregate([{ $match: filter }, { $group: { _id: null, value: { $sum: { $ifNull: [`$${field}`, 0] } } } }]);
  return result[0]?.value || 0;
}

async function groupedStatus(name, filter) {
  const Model = model(name);
  if (!Model) return [];
  return Model.aggregate([{ $match: filter }, { $group: { _id: { $ifNull: ['$status', 'Unknown'] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
}

function oid(value) { return new mongoose.Types.ObjectId(value); }

async function executive(hospitalId, start, end) {
  const h = oid(hospitalId);
  const admissionDate = { hospitalId: h, ...dateFilter('admissionDate', start, end) };
  const created = { hospitalId: h, ...dateFilter('createdAt', start, end) };
  const snakeCreated = { hospital_id: h, ...dateFilter('createdAt', start, end) };
  const [admissions, discharges, appointments, otCases, labRequests, radiologyRequests, invoices, billed, storeValue] = await Promise.all([
    count('IPDAdmission', admissionDate),
    count('IPDAdmission', { hospitalId: h, status: 'Discharged', ...dateFilter('dischargeDate', start, end) }),
    count('Appointment', { hospital_id: h, ...dateFilter('createdAt', start, end) }),
    count('OTRequest', created), count('LabRequest', created), count('RadiologyRequest', created), count('Invoice', snakeCreated),
    sum('Invoice', snakeCreated, 'grand_total'),
    model('StoreItem') ? model('StoreItem').aggregate([{ $match: { hospital_id: h, is_active: true } }, { $group: { _id: null, value: { $sum: { $multiply: [{ $ifNull: ['$current_stock', 0] }, { $ifNull: ['$average_cost', 0] }] } } } }]).then((rows) => rows[0]?.value || 0) : 0
  ]);
  return { cards: [
    ['Admissions', admissions], ['Discharges', discharges], ['Appointments', appointments], ['OT cases', otCases],
    ['Lab requests', labRequests], ['Radiology requests', radiologyRequests], ['Invoices', invoices], ['Gross billed', billed], ['Inventory value', storeValue]
  ].map(([label, value]) => ({ label, value })) };
}

async function ot(hospitalId, start, end) {
  const filter = { hospitalId: oid(hospitalId), ...dateFilter('requestedDate', start, end) };
  const Model = model('OTRequest');
  const [total, statuses, readiness, byProcedure, durations] = await Promise.all([
    Model.countDocuments(filter), groupedStatus('OTRequest', filter),
    Model.aggregate([{ $match: filter }, { $group: { _id: { $ifNull: ['$readinessStatus', 'Unknown'] }, count: { $sum: 1 } } }]),
    Model.aggregate([{ $match: filter }, { $group: { _id: { $ifNull: ['$procedureName', 'Unspecified'] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]),
    Model.aggregate([{ $match: { ...filter, startedAt: { $ne: null }, completedAt: { $ne: null } } }, { $project: { minutes: { $divide: [{ $subtract: ['$completedAt', '$startedAt'] }, 60000] } } }, { $group: { _id: null, averageMinutes: { $avg: '$minutes' } } }])
  ]);
  return { cards: [{ label: 'Cases', value: total }, { label: 'Average surgery minutes', value: Math.round(durations[0]?.averageMinutes || 0) }], series: { statuses, readiness, byProcedure } };
}

async function store(hospitalId, start, end) {
  const h = oid(hospitalId);
  const txFilter = { hospital_id: h, ...dateFilter('createdAt', start, end) };
  const [stock, transactions, byType, lotsExpiring, reservations, grns, variances] = await Promise.all([
    model('StoreItem').aggregate([{ $match: { hospital_id: h, is_active: true } }, { $group: { _id: null, items: { $sum: 1 }, units: { $sum: '$current_stock' }, value: { $sum: { $multiply: [{ $ifNull: ['$current_stock', 0] }, { $ifNull: ['$average_cost', 0] }] } }, lowStock: { $sum: { $cond: [{ $lte: ['$current_stock', { $ifNull: ['$reorder_level', 0] }] }, 1, 0] } } } }]),
    count('StoreInventoryTransaction', txFilter),
    model('StoreInventoryTransaction').aggregate([{ $match: txFilter }, { $group: { _id: '$transaction_type', count: { $sum: 1 }, quantity: { $sum: '$quantity' }, value: { $sum: '$total_cost' } } }, { $sort: { count: -1 } }]),
    count('InventoryLot', { hospitalId: h, totalOnHand: { $gt: 0 }, expiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 90 * 86400000) } }),
    count('StockReservation', { hospitalId: h, status: { $in: ['Active', 'Partially Issued'] } }),
    count('GoodsReceiptNote', { hospitalId: h, ...dateFilter('receivedAt', start, end) }),
    sum('StoreInventoryTransaction', { ...txFilter, transaction_type: 'count_variance' }, 'quantity')
  ]);
  const overview = stock[0] || { items: 0, units: 0, value: 0, lowStock: 0 };
  return { cards: [
    { label: 'Active items', value: overview.items }, { label: 'On-hand units', value: overview.units }, { label: 'Inventory value', value: overview.value },
    { label: 'Low-stock items', value: overview.lowStock }, { label: 'Expiring lots (90d)', value: lotsExpiring }, { label: 'Active reservations', value: reservations },
    { label: 'GRNs', value: grns }, { label: 'Transactions', value: transactions }, { label: 'Count variance units', value: variances }
  ], series: { byType } };
}

async function standardStatusReport(name, hospitalField, hospitalId, dateField, start, end, extraCards = []) {
  const filter = { [hospitalField]: oid(hospitalId), ...dateFilter(dateField, start, end) };
  const total = await count(name, filter);
  return { cards: [{ label: 'Total records', value: total }, ...extraCards], series: { statuses: await groupedStatus(name, filter) } };
}

async function buildReport(key, hospitalId, startDate, endDate) {
  let data;
  if (key === 'executive') data = await executive(hospitalId, startDate, endDate);
  else if (key === 'ot') data = await ot(hospitalId, startDate, endDate);
  else if (key === 'store') data = await store(hospitalId, startDate, endDate);
  else if (key === 'ipd') data = await standardStatusReport('IPDAdmission', 'hospitalId', hospitalId, 'admissionDate', startDate, endDate);
  else if (key === 'opd') data = await standardStatusReport('Appointment', 'hospital_id', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'lab') data = await standardStatusReport('LabRequest', 'hospitalId', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'radiology') data = await standardStatusReport('RadiologyRequest', 'hospitalId', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'billing') data = await standardStatusReport('Invoice', 'hospital_id', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'pharmacy') data = await standardStatusReport('Pharmacy', 'hospital_id', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'hr') data = await standardStatusReport('HRStaffProfile', 'hospital_id', hospitalId, 'createdAt', startDate, endDate);
  else if (key === 'clinical-quality') {
    const h = oid(hospitalId);
    const [consents, completedConsents, documents, signed, requiredOT, finalOT] = await Promise.all([
      count('IPDConsent', { hospitalId: h, ...dateFilter('createdAt', startDate, endDate) }),
      count('IPDConsent', { hospitalId: h, status: { $in: ['Completed', 'Signed'] }, ...dateFilter('createdAt', startDate, endDate) }),
      count('EncounterDocument', { hospitalId: h, ...dateFilter('createdAt', startDate, endDate) }),
      count('DocumentSignature', { hospitalId: h, status: 'signed', ...dateFilter('signedAt', startDate, endDate) }),
      count('OTCaseClinicalForm', { hospitalId: h, required: true, ...dateFilter('createdAt', startDate, endDate) }),
      count('OTCaseClinicalForm', { hospitalId: h, required: true, status: { $in: ['Final', 'Signed'] }, ...dateFilter('createdAt', startDate, endDate) })
    ]);
    data = { cards: [
      { label: 'Consents', value: consents }, { label: 'Completed consents', value: completedConsents },
      { label: 'Clinical documents', value: documents }, { label: 'Digitally signed', value: signed },
      { label: 'Required OT forms', value: requiredOT }, { label: 'Final OT forms', value: finalOT }
    ] };
  } else {
    const error = new Error('MIS report not found'); error.statusCode = 404; throw error;
  }
  return { report: REPORT_CATALOG.find((item) => item.key === key), filters: { startDate, endDate }, generatedAt: new Date().toISOString(), ...data };
}

function flattenReport(report) {
  const rows = [
    ['Report', report.report?.label || 'MIS Report'], ['Module', report.report?.module || ''],
    ['Start date', report.filters?.startDate || ''], ['End date', report.filters?.endDate || ''],
    ['Generated at', report.generatedAt || ''], [], ['Metric', 'Value'],
    ...(report.cards || []).map((card) => [card.label, card.value])
  ];
  Object.entries(report.series || {}).forEach(([name, values]) => {
    rows.push([], [name, 'Dimension', 'Count', 'Quantity', 'Value']);
    (values || []).forEach((row) => rows.push(['', typeof row._id === 'object' ? JSON.stringify(row._id) : row._id, row.count, row.quantity, row.value]));
  });
  return rows;
}

function csvEscape(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
async function renderExport(report, format) {
  const rows = flattenReport(report);
  const safe = `${report.report?.key || 'mis'}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    const output = Buffer.from(rows.map((row) => row.map(csvEscape).join(',')).join('\n'), 'utf8');
    return { output, filename: `${safe}.csv`, mimeType: 'text/csv; charset=utf-8', rowCount: rows.length };
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('MIS Report');
    rows.forEach((row) => sheet.addRow(row));
    sheet.columns.forEach((column) => { column.width = Math.min(60, Math.max(12, ...(column.values || []).map((v) => String(v ?? '').length + 2))); });
    sheet.getRow(1).font = { bold: true };
    const output = Buffer.from(await workbook.xlsx.writeBuffer());
    return { output, filename: `${safe}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', rowCount: rows.length };
  }
  const output = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks = []; doc.on('data', (chunk) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(16).font('Helvetica-Bold').text(report.report?.label || 'MIS Report');
    doc.moveDown(0.3).fontSize(9).font('Helvetica').text(`Period: ${report.filters?.startDate || 'All'} to ${report.filters?.endDate || 'All'} | Generated: ${report.generatedAt}`);
    doc.moveDown();
    (report.cards || []).forEach((card) => { if (doc.y > 760) doc.addPage(); doc.font('Helvetica-Bold').fontSize(10).text(`${card.label}: `, { continued: true }).font('Helvetica').text(String(card.value ?? '—')); });
    Object.entries(report.series || {}).forEach(([name, values]) => {
      if (doc.y > 700) doc.addPage(); doc.moveDown().font('Helvetica-Bold').fontSize(12).text(name.replace(/([A-Z])/g, ' $1'));
      (values || []).forEach((row) => { if (doc.y > 760) doc.addPage(); doc.font('Helvetica').fontSize(8).text(`${typeof row._id === 'object' ? JSON.stringify(row._id) : row._id || 'Unknown'} | Count ${row.count ?? ''} | Qty ${row.quantity ?? ''} | Value ${row.value ?? ''}`); });
    });
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) { doc.switchToPage(i); doc.fontSize(7).fillColor('#555').text(`Page ${i + 1} of ${range.count}`, 36, 805, { align: 'right', width: 523 }); }
    doc.end();
  });
  return { output, filename: `${safe}.pdf`, mimeType: 'application/pdf', rowCount: rows.length };
}

async function processExportJob(job) {
  try {
    job.status = 'Processing'; await job.save();
    const report = await buildReport(job.reportKey, job.hospitalId, job.filters?.startDate, job.filters?.endDate);
    const rendered = await renderExport(report, job.format);
    job.output = rendered.output; job.filename = rendered.filename; job.mimeType = rendered.mimeType; job.rowCount = rendered.rowCount;
    job.checksum = crypto.createHash('sha256').update(rendered.output).digest('hex');
    job.status = 'Completed'; job.completedAt = new Date(); job.expiresAt = new Date(Date.now() + 7 * 86400000); await job.save();
  } catch (error) { job.status = 'Failed'; job.error = error.message; job.completedAt = new Date(); await job.save(); }
  return job;
}

function nextScheduleRun(schedule, from = new Date()) {
  const next = new Date(from); next.setSeconds(0, 0);
  const [hours, minutes] = String(schedule.timeOfDay || '07:00').split(':').map(Number);
  next.setHours(hours || 0, minutes || 0, 0, 0);
  if (schedule.frequency === 'Daily') { if (next <= from) next.setDate(next.getDate() + 1); }
  else if (schedule.frequency === 'Weekly') {
    const day = Number(schedule.dayOfWeek ?? 1); let delta = (day - next.getDay() + 7) % 7;
    if (delta === 0 && next <= from) delta = 7; next.setDate(next.getDate() + delta);
  } else {
    const day = Math.min(28, Math.max(1, Number(schedule.dayOfMonth || 1))); next.setDate(day);
    if (next <= from) { next.setMonth(next.getMonth() + 1); next.setDate(day); }
  }
  return next;
}

exports.buildReport = buildReport;
exports.catalog = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const overrides = await MISMetricDefinition.find({ $or: [{ hospitalId }, { hospitalId: null }], isActive: true }).lean();
    const byCode = new Map(overrides.map((item) => [item.code, item]));
    res.json({ success: true, data: REPORT_CATALOG.map((item) => ({ ...item, definition: byCode.get(item.key) || null })) });
  } catch (error) { next(error); }
};

exports.run = async (req, res, next) => {
  try { const data = await buildReport(req.params.key, requireHospitalId(req), req.query.startDate, req.query.endDate); res.json({ success: true, data }); }
  catch (error) { next(error); }
};

exports.query = async (req, res, next) => {
  try {
    const key = req.body.reportKey || req.body.metricCode;
    if (!key) return res.status(400).json({ error: 'reportKey is required' });
    const data = await buildReport(key, requireHospitalId(req), req.body.filters?.startDate, req.body.filters?.endDate);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.createExport = async (req, res, next) => {
  try {
    if (!['csv', 'xlsx', 'pdf'].includes(req.body.format)) return res.status(400).json({ error: 'format must be csv, xlsx or pdf' });
    const job = await MISExportJob.create({ hospitalId: requireHospitalId(req), requestedBy: req.user._id, reportKey: req.body.reportKey, filters: req.body.filters || {}, format: req.body.format });
    await processExportJob(job);
    res.status(201).json({ success: true, data: { _id: job._id, status: job.status, filename: job.filename, checksum: job.checksum, rowCount: job.rowCount, error: job.error } });
  } catch (error) { next(error); }
};
exports.listExports = async (req, res, next) => { try { const data = await MISExportJob.find({ hospitalId: requireHospitalId(req), requestedBy: req.user._id }).select('-output').sort({ createdAt: -1 }).limit(100); res.json({ success: true, data }); } catch (error) { next(error); } };
exports.getExport = async (req, res, next) => { try { const job = await MISExportJob.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req), requestedBy: req.user._id }); if (!job) return res.status(404).json({ error: 'Export not found' }); res.json({ success: true, data: { _id: job._id, status: job.status, filename: job.filename, checksum: job.checksum, rowCount: job.rowCount, error: job.error, completedAt: job.completedAt } }); } catch (error) { next(error); } };
exports.downloadExport = async (req, res, next) => { try { const job = await MISExportJob.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req), requestedBy: req.user._id }); if (!job || job.status !== 'Completed' || !job.output) return res.status(404).json({ error: 'Completed export not found' }); res.setHeader('Content-Type', job.mimeType); res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`); res.setHeader('X-Content-SHA256', job.checksum); res.send(job.output); } catch (error) { next(error); } };

exports.listSchedules = async (req, res, next) => { try { res.json({ success: true, data: await MISSchedule.find({ hospitalId: requireHospitalId(req) }).sort({ createdAt: -1 }) }); } catch (error) { next(error); } };
exports.createSchedule = async (req, res, next) => { try { const payload = { ...req.body, hospitalId: requireHospitalId(req), createdBy: req.user._id }; payload.nextRunAt = nextScheduleRun(payload); const record = await MISSchedule.create(payload); res.status(201).json({ success: true, data: record }); } catch (error) { next(error); } };
exports.updateSchedule = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const existing = await MISSchedule.findOne({ _id: req.params.id, hospitalId }).lean();
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });

    const payload = { ...req.body, updatedBy: req.user._id };
    payload.nextRunAt = nextScheduleRun({ ...existing, ...payload });

    const record = await MISSchedule.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: payload },
      { new: true, runValidators: true }
    );
    return res.json({ success: true, data: record });
  } catch (error) {
    return next(error);
  }
};
exports.deleteSchedule = async (req, res, next) => { try { const record = await MISSchedule.findOneAndDelete({ _id: req.params.id, hospitalId: requireHospitalId(req) }); if (!record) return res.status(404).json({ error: 'Schedule not found' }); res.json({ success: true }); } catch (error) { next(error); } };

exports.createSnapshot = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req); const key = req.body.reportKey; const startDate = req.body.startDate; const endDate = req.body.endDate;
    const payload = await buildReport(key, hospitalId, startDate, endDate); const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const record = await MISSnapshot.findOneAndUpdate({ hospitalId, reportKey: key, grain: req.body.grain || 'day', periodStart: new Date(startDate) }, { $set: { periodEnd: new Date(endDate || startDate), payload, sourceChecksum: checksum, generatedAt: new Date(), status: 'Fresh', errors: [] } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.status(201).json({ success: true, data: record });
  } catch (error) { next(error); }
};
exports.listSnapshots = async (req, res, next) => { try { const filter = { hospitalId: requireHospitalId(req) }; if (req.query.reportKey) filter.reportKey = req.query.reportKey; res.json({ success: true, data: await MISSnapshot.find(filter).select('-payload').sort({ generatedAt: -1 }).limit(100) }); } catch (error) { next(error); } };
exports.dataQuality = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req); const h = oid(hospitalId); const staleCutoff = new Date(Date.now() - 48 * 3600000);
    const checks = await Promise.all([
      count('OTRequest', { hospitalId: h, admissionId: null }).then((value) => ({ key: 'ot_missing_admission', label: 'OT cases missing admission linkage', value, status: value ? 'Exception' : 'Pass' })),
      count('EncounterDocument', { hospitalId: h, status: { $in: ['Draft', 'Completed'] }, signatureStatus: { $ne: 'Signed' } }).then((value) => ({ key: 'unsigned_documents', label: 'Draft/completed unsigned documents', value, status: value ? 'Warning' : 'Pass' })),
      count('InventoryLot', { hospitalId: h, totalOnHand: { $lt: 0 } }).then((value) => ({ key: 'negative_lot_balance', label: 'Lots with negative on-hand balance', value, status: value ? 'Exception' : 'Pass' })),
      count('MISSnapshot', { hospitalId: h, generatedAt: { $lt: staleCutoff } }).then((value) => ({ key: 'stale_snapshots', label: 'MIS snapshots older than 48 hours', value, status: value ? 'Warning' : 'Pass' }))
    ]);
    res.json({ success: true, data: { checkedAt: new Date(), checks, overall: checks.some((x) => x.status === 'Exception') ? 'Exception' : checks.some((x) => x.status === 'Warning') ? 'Warning' : 'Pass' } });
  } catch (error) { next(error); }
};

exports.processExportJob = processExportJob;
exports.nextScheduleRun = nextScheduleRun;
