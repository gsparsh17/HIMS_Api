const ExcelJS = require('exceljs');
const financial = require('../services/ipdFinancial.service');
const mis = require('../services/misReporting.service');

function sendError(res, error) {
  console.error('Finance module error:', error);
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.message || 'Financial operation failed',
    details: error.details
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function safeSheetName(value) {
  return String(value || 'Report').replace(/[\\/*?:\[\]]/g, '').slice(0, 31) || 'Report';
}

async function exportReport(res, report, format) {
  const filename = `${report.reportKey || 'mis-report'}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'csv') {
    const csv = [
      report.columns.join(','),
      ...report.rows.map((row) => report.columns.map((column) => csvCell(row[column])).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(`\uFEFF${csv}`);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'HIMS Finance MIS';
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(safeSheetName(report.title));
  worksheet.addRow([report.title]);
  worksheet.mergeCells(1, 1, 1, Math.max(1, report.columns.length));
  worksheet.getCell('A1').font = { bold: true, size: 15 };
  worksheet.addRow([`Period: ${new Date(report.range.dateFrom).toLocaleDateString('en-IN')} to ${new Date(report.range.dateTo).toLocaleDateString('en-IN')}`]);
  worksheet.mergeCells(2, 1, 2, Math.max(1, report.columns.length));
  worksheet.addRow([]);
  const header = worksheet.addRow(report.columns.map((column) => column.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())));
  header.font = { bold: true };
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2F0F9' } }; });
  report.rows.forEach((row) => worksheet.addRow(report.columns.map((column) => row[column] ?? '')));
  worksheet.columns.forEach((column) => { column.width = 18; });
  worksheet.views = [{ state: 'frozen', ySplit: 4 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

exports.getDashboard = async (req, res) => {
  try {
    const overview = await mis.getMISOverview(req.query, req.user);
    res.json({ success: true, ...overview });
  } catch (error) { sendError(res, error); }
};

exports.getMISOverview = async (req, res) => {
  try {
    const overview = await mis.getMISOverview(req.query, req.user);
    res.json({ success: true, ...overview });
  } catch (error) { sendError(res, error); }
};

exports.getMISReport = async (req, res) => {
  try {
    const report = await mis.getMISReport(req.params.reportKey, req.query, req.user);
    res.json({ success: true, ...report });
  } catch (error) { sendError(res, error); }
};

exports.exportMISReport = async (req, res) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    if (!['xlsx', 'csv'].includes(format)) {
      const error = new Error('Only xlsx and csv exports are supported');
      error.statusCode = 400;
      throw error;
    }
    const report = await mis.getMISReport(req.params.reportKey, req.query, req.user);
    await exportReport(res, report, format);
  } catch (error) { sendError(res, error); }
};

exports.getRunningBill = async (req, res) => {
  try {
    res.json(await financial.getRunningBill(req.params.admissionId, req.user));
  } catch (error) { sendError(res, error); }
};

exports.getFinancialLedger = async (req, res) => {
  try {
    res.json(await financial.getFinancialLedger(req.params.admissionId, req.user));
  } catch (error) { sendError(res, error); }
};

exports.getFinancialClearance = async (req, res) => {
  try {
    res.json(await financial.getFinancialClearance(req.params.admissionId, req.user));
  } catch (error) { sendError(res, error); }
};

exports.addIPDCharge = async (req, res) => {
  try {
    const charge = await financial.addManualCharge({ ...req.body, admissionId: req.params.admissionId || req.body.admissionId }, req.user);
    res.status(201).json({ success: true, message: 'Charge added successfully', charge });
  } catch (error) { sendError(res, error); }
};

exports.voidIPDCharge = async (req, res) => {
  try {
    const charge = await financial.voidCharge(req.params.admissionId, req.params.chargeId, req.body, req.user);
    res.json({ success: true, message: 'Charge voided successfully', charge });
  } catch (error) { sendError(res, error); }
};

exports.generateBedCharge = async (req, res) => {
  try {
    const result = await financial.generateBedCharge(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Bed charge already exists for this date' : 'Bed charge generated successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.applyIPDDiscount = async (req, res) => {
  try {
    const charge = await financial.applyDiscount(req.params.admissionId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Discount applied successfully', charge });
  } catch (error) { sendError(res, error); }
};

exports.issueIPDInvoice = async (req, res) => {
  try {
    const result = await financial.issueIPDInvoice(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Existing invoice returned' : 'IPD invoice issued successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.recordIPDPayment = async (req, res) => {
  try {
    const result = await financial.recordIPDPayment(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Existing receipt returned' : 'Payment receipt posted successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.recordIPDAdvance = async (req, res) => {
  try {
    const result = await financial.recordAdvance(req.params.admissionId, req.body, req.user);
    res.status(result.alreadyExists ? 200 : 201).json({ success: true, message: result.alreadyExists ? 'Existing advance receipt returned' : 'IPD advance received successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.refundIPDAdvance = async (req, res) => {
  try {
    const result = await financial.refundAdvance(req.params.admissionId, req.body, req.user);
    res.status(201).json({ success: true, message: 'IPD advance refund posted successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.createCreditNote = async (req, res) => {
  try {
    const result = await financial.createCreditNote(req.params.invoiceId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Credit note created successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.refundInvoice = async (req, res) => {
  try {
    const result = await financial.refundInvoice(req.params.invoiceId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Refund posted successfully', ...result });
  } catch (error) { sendError(res, error); }
};

exports.finaliseIPDClearance = async (req, res) => {
  try {
    const result = await financial.finaliseFinancialClearance(req.params.admissionId, req.body, req.user);
    res.json({ success: true, message: result.clearance.ready ? 'Financial clearance completed' : 'Financial exception recorded', ...result });
  } catch (error) { sendError(res, error); }
};
