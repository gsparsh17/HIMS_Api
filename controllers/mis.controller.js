const mongoose = require('mongoose');
const { requireHospitalId } = require('../services/tenantScope.service');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const MISMetricDefinition = require('../models/MISMetricDefinition');
const MISSnapshot = require('../models/MISSnapshot');
const MISExportJob = require('../models/MISExportJob');
const MISSchedule = require('../models/MISSchedule');

const { REPORT_CATALOG, buildOperationalReport } = require('../services/misOperationalReport.service');

// ============================================
// Role-Based Access Control
// ============================================

const REPORT_ROLE_ACCESS = {
  pathology_staff: ['lab-workload', 'lab-tat', 'lab'],
  radiology_staff: ['radiology-workload', 'radiology-tat', 'radiology'],
  pharmacy: ['pharmacy-activity', 'pharmacy'],
  ot_staff: ['ot-cases', 'ot-utilisation', 'ot'],
  store: ['store'],
  store_manager: ['store'],
  inventory_manager: ['store'],
  hr: ['hr'],
  hr_manager: ['hr'],
  accountant: ['billing-revenue', 'billing-refunds', 'billing', 'executive'],
  insurance_desk: ['billing-revenue', 'billing-refunds', 'billing'],
  doctor: [
    'opd-visits',
    'opd-ipd-followup',
    'appointment-status',
    'opd-cancelled',
    'ipd-admissions',
    'ipd-discharges',
    'ipd-bed-occupancy',
    'ipd-deaths',
    'ipd-medico-status',
    'lab-workload',
    'lab-tat',
    'radiology-workload',
    'radiology-tat',
    'procedure-workload',
    'ot-cases',
    'ot-utilisation',
    'clinical-quality',
    'opd',
    'ipd',
    'lab',
    'radiology',
    'ot'
  ],
  nurse: [
    'ipd-admissions',
    'ipd-discharges',
    'ipd-bed-occupancy',
    'ipd-newborn',
    'ipd-deaths',
    'ipd-medico-status',
    'lab-workload',
    'lab-tat',
    'clinical-quality',
    'ipd',
    'lab'
  ],
  staff: [
    'opd-visits',
    'opd-ipd-followup',
    'appointment-status',
    'opd-cancelled',
    'ipd-admissions',
    'ipd-discharges',
    'ipd-bed-occupancy',
    'ipd-newborn',
    'ipd-deaths',
    'ipd-medico-status',
    'billing-revenue',
    'billing-refunds',
    'procedure-workload',
    'opd',
    'ipd',
    'billing'
  ],
  registrar: [
    'opd-visits',
    'opd-ipd-followup',
    'appointment-status',
    'opd-cancelled',
    'ipd-admissions',
    'ipd-discharges',
    'ipd-bed-occupancy',
    'ipd-newborn',
    'ipd-deaths',
    'ipd-medico-status',
    'billing-revenue',
    'billing-refunds',
    'opd',
    'ipd',
    'billing'
  ],
  receptionist: [
    'opd-visits',
    'appointment-status',
    'opd-cancelled',
    'ipd-admissions',
    'ipd-bed-occupancy',
    'opd',
    'ipd'
  ]
};

function reportAllowedForUser(user, key) {
  const role = String(user?.role || '').toLowerCase();

  if (['admin', 'mediqliq_super_admin'].includes(role)) {
    return true;
  }

  const allowed = REPORT_ROLE_ACCESS[role] || [];
  return allowed.includes(key);
}

function assertReportAccess(req, key) {
  if (!reportAllowedForUser(req.user, key)) {
    const error = new Error('You are not authorized to access this MIS report');
    error.statusCode = 403;
    throw error;
  }
}

// ============================================
// Model Helpers
// ============================================

function model(name) {
  try {
    return mongoose.model(name);
  } catch (_error) {
    return null;
  }
}

// ============================================
// Date Helpers
// ============================================

const IST_OFFSET_MINUTES = 330;

function reportBoundary(value, endOfDay = false) {
  if (!value) {
    return undefined;
  }

  const text = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const utcMillis = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0
    ) - (IST_OFFSET_MINUTES * 60 * 1000);

    return new Date(utcMillis);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function dateFilter(field, start, end) {
  if (!start && !end) {
    return {};
  }

  const value = {};
  const startBoundary = reportBoundary(start, false);
  const endBoundary = reportBoundary(end, true);

  if (startBoundary) {
    value.$gte = startBoundary;
  }

  if (endBoundary) {
    value.$lte = endBoundary;
  }

  return Object.keys(value).length ? { [field]: value } : {};
}

// ============================================
// Aggregation Helpers
// ============================================

async function count(name, filter) {
  const Model = model(name);
  return Model ? Model.countDocuments(filter) : 0;
}

async function sum(name, filter, field) {
  const Model = model(name);

  if (!Model) {
    return 0;
  }

  const result = await Model.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        value: { $sum: { $ifNull: [`$${field}`, 0] } }
      }
    }
  ]);

  return result[0]?.value || 0;
}

async function groupedStatus(name, filter) {
  const Model = model(name);

  if (!Model) {
    return [];
  }

  return Model.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { $ifNull: ['$status', 'Unknown'] },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1 } }
  ]);
}

function oid(value) {
  return new mongoose.Types.ObjectId(value);
}

// ============================================
// Executive Report
// ============================================

async function executive(hospitalId, start, end) {
  const hospital = oid(hospitalId);

  // Use each workflow's business/event date. createdAt is not a valid field on
  // Appointment (created_at is) and, more importantly, creation time is not the
  // date on which an appointment/diagnostic/OT activity belongs in MIS.
  const admissionDate = {
    hospitalId: hospital,
    ...dateFilter('admissionDate', start, end)
  };

  const dischargeDate = {
    hospitalId: hospital,
    status: { $in: ['Discharged', 'LAMA', 'DAMA', 'Expired'] },
    ...dateFilter('dischargeDate', start, end)
  };

  const appointmentDate = {
    hospital_id: hospital,
    ...dateFilter('appointment_date', start, end)
  };

  const otDate = {
    hospitalId: hospital,
    ...dateFilter('requestedDate', start, end)
  };

  const labDate = {
    hospitalId: hospital,
    ...dateFilter('requestedDate', start, end)
  };

  const radiologyDate = {
    hospitalId: hospital,
    ...dateFilter('requestedDate', start, end)
  };

  const invoiceDate = {
    hospital_id: hospital,
    ...dateFilter('issue_date', start, end)
  };

  const [
    admissions,
    discharges,
    appointments,
    otCases,
    labRequests,
    radiologyRequests,
    invoices,
    billed,
    storeValue
  ] = await Promise.all([
    count('IPDAdmission', admissionDate),
    count('IPDAdmission', dischargeDate),
    count('Appointment', appointmentDate),
    count('OTRequest', otDate),
    count('LabRequest', labDate),
    count('RadiologyRequest', radiologyDate),
    count('Invoice', invoiceDate),
    sum('Invoice', invoiceDate, 'total'),
    model('StoreItem')
      ? model('StoreItem').aggregate([
          { $match: { hospital_id: hospital, is_active: true } },
          {
            $group: {
              _id: null,
              value: {
                $sum: {
                  $multiply: [
                    { $ifNull: ['$current_stock', 0] },
                    { $ifNull: ['$average_cost', 0] }
                  ]
                }
              }
            }
          }
        ]).then((rows) => rows[0]?.value || 0)
      : 0
  ]);

  return {
    cards: [
      ['Admissions', admissions],
      ['Discharges', discharges],
      ['Appointments', appointments],
      ['OT cases', otCases],
      ['Lab requests', labRequests],
      ['Radiology requests', radiologyRequests],
      ['Invoices', invoices],
      ['Gross billed', billed],
      ['Inventory value', storeValue]
    ].map(([label, value]) => ({ label, value }))
  };
}

// ============================================
// OT Report
// ============================================

async function ot(hospitalId, start, end) {
  const filter = {
    hospitalId: oid(hospitalId),
    ...dateFilter('requestedDate', start, end)
  };

  const Model = model('OTRequest');

  const [total, statuses, readiness, byProcedure, durations] = await Promise.all([
    Model.countDocuments(filter),
    groupedStatus('OTRequest', filter),
    Model.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $ifNull: ['$readinessStatus', 'Unknown'] },
          count: { $sum: 1 }
        }
      }
    ]),
    Model.aggregate([
      { $match: filter },
      {
        $group: {
          _id: { $ifNull: ['$procedureName', 'Unspecified'] },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]),
    Model.aggregate([
      {
        $match: {
          ...filter,
          startedAt: { $ne: null },
          completedAt: { $ne: null }
        }
      },
      {
        $project: {
          minutes: {
            $divide: [
              { $subtract: ['$completedAt', '$startedAt'] },
              60000
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          averageMinutes: { $avg: '$minutes' }
        }
      }
    ])
  ]);

  return {
    cards: [
      { label: 'Cases', value: total },
      { label: 'Average surgery minutes', value: Math.round(durations[0]?.averageMinutes || 0) }
    ],
    series: { statuses, readiness, byProcedure }
  };
}

// ============================================
// Store Report
// ============================================

async function store(hospitalId, start, end) {
  const hospital = oid(hospitalId);

  const txFilter = {
    hospital_id: hospital,
    ...dateFilter('createdAt', start, end)
  };

  const [
    stock,
    transactions,
    byType,
    lotsExpiring,
    reservations,
    grns,
    variances
  ] = await Promise.all([
    model('StoreItem').aggregate([
      { $match: { hospital_id: hospital, is_active: true } },
      {
        $group: {
          _id: null,
          items: { $sum: 1 },
          units: { $sum: '$current_stock' },
          value: {
            $sum: {
              $multiply: [
                { $ifNull: ['$current_stock', 0] },
                { $ifNull: ['$average_cost', 0] }
              ]
            }
          },
          lowStock: {
            $sum: {
              $cond: [
                { $lte: ['$current_stock', { $ifNull: ['$reorder_level', 0] }] },
                1,
                0
              ]
            }
          }
        }
      }
    ]),
    count('StoreInventoryTransaction', txFilter),
    model('StoreInventoryTransaction').aggregate([
      { $match: txFilter },
      {
        $group: {
          _id: '$transaction_type',
          count: { $sum: 1 },
          quantity: { $sum: '$quantity' },
          value: { $sum: '$total_cost' }
        }
      },
      { $sort: { count: -1 } }
    ]),
    count('InventoryLot', {
      hospitalId: hospital,
      totalOnHand: { $gt: 0 },
      expiryDate: {
        $gte: new Date(),
        $lte: new Date(Date.now() + 90 * 86400000)
      }
    }),
    count('StockReservation', {
      hospitalId: hospital,
      status: { $in: ['Active', 'Partially Issued'] }
    }),
    count('GoodsReceiptNote', {
      hospitalId: hospital,
      ...dateFilter('receivedAt', start, end)
    }),
    sum('StoreInventoryTransaction', {
      ...txFilter,
      transaction_type: 'count_variance'
    }, 'quantity')
  ]);

  const overview = stock[0] || { items: 0, units: 0, value: 0, lowStock: 0 };

  return {
    cards: [
      { label: 'Active items', value: overview.items },
      { label: 'On-hand units', value: overview.units },
      { label: 'Inventory value', value: overview.value },
      { label: 'Low-stock items', value: overview.lowStock },
      { label: 'Expiring lots (90d)', value: lotsExpiring },
      { label: 'Active reservations', value: reservations },
      { label: 'GRNs', value: grns },
      { label: 'Transactions', value: transactions },
      { label: 'Count variance units', value: variances }
    ],
    series: { byType }
  };
}

// ============================================
// Standard Status Report
// ============================================

async function standardStatusReport(
  name,
  hospitalField,
  hospitalId,
  dateField,
  start,
  end,
  extraCards = []
) {
  const filter = {
    [hospitalField]: oid(hospitalId),
    ...dateFilter(dateField, start, end)
  };

  const total = await count(name, filter);

  return {
    cards: [{ label: 'Total records', value: total }, ...extraCards],
    series: { statuses: await groupedStatus(name, filter) }
  };
}

// ============================================
// Build Report
// ============================================

async function buildReport(key, hospitalId, startDate, endDate, extraFilters = {}) {
  const filters = (startDate && typeof startDate === 'object' && !(startDate instanceof Date))
    ? { ...startDate }
    : { ...extraFilters, startDate, endDate };

  const operational = await buildOperationalReport(key, hospitalId, filters);
  let data = operational;

  if (!data && key === 'executive') {
    data = await executive(hospitalId, filters.startDate, filters.endDate);
  } else if (!data && key === 'store') {
    data = await store(hospitalId, filters.startDate, filters.endDate);
  } else if (!data && key === 'hr') {
    data = await standardStatusReport(
      'HRStaffProfile',
      'hospital_id',
      hospitalId,
      'createdAt',
      filters.startDate,
      filters.endDate
    );
  } else if (!data && key === 'clinical-quality') {
    const hospital = oid(hospitalId);

    const [
      consents,
      completedConsents,
      documents,
      signed,
      requiredOT,
      finalOT
    ] = await Promise.all([
      count('IPDConsent', {
        hospitalId: hospital,
        ...dateFilter('createdAt', filters.startDate, filters.endDate)
      }),
      count('IPDConsent', {
        hospitalId: hospital,
        status: { $in: ['Completed', 'Signed'] },
        ...dateFilter('createdAt', filters.startDate, filters.endDate)
      }),
      count('EncounterDocument', {
        hospitalId: hospital,
        ...dateFilter('createdAt', filters.startDate, filters.endDate)
      }),
      count('DocumentSignature', {
        hospitalId: hospital,
        status: 'signed',
        ...dateFilter('signedAt', filters.startDate, filters.endDate)
      }),
      count('OTCaseClinicalForm', {
        hospitalId: hospital,
        required: true,
        ...dateFilter('createdAt', filters.startDate, filters.endDate)
      }),
      count('OTCaseClinicalForm', {
        hospitalId: hospital,
        required: true,
        status: { $in: ['Final', 'Signed'] },
        ...dateFilter('createdAt', filters.startDate, filters.endDate)
      })
    ]);

    data = {
      cards: [
        { label: 'Consents', value: consents },
        { label: 'Completed consents', value: completedConsents },
        { label: 'Clinical documents', value: documents },
        { label: 'Digitally signed', value: signed },
        { label: 'Required OT forms', value: requiredOT },
        { label: 'Final OT forms', value: finalOT }
      ]
    };
  }

  if (!data) {
    const error = new Error('MIS report not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    report: REPORT_CATALOG.find((item) => item.key === key),
    filters,
    generatedAt: new Date().toISOString(),
    ...data
  };
}

// ============================================
// Flatten Report for Export
// ============================================

function flattenReport(report) {
  const rows = [
    ['Report', report.report?.label || 'MIS Report'],
    ['Module', report.report?.module || ''],
    ['Start date', report.filters?.startDate || ''],
    ['End date', report.filters?.endDate || ''],
    ['Generated at', report.generatedAt || ''],
    [],
    ['Metric', 'Value'],
    ...(report.cards || []).map((card) => [card.label, card.value])
  ];

  if (Array.isArray(report.rows) && report.rows.length) {
    const preferred = [
      'period',
      'careSetting',
      'visitType',
      'status',
      'medicoStatus',
      'department',
      'doctor',
      'surgeon',
      'procedure',
      'test',
      'ward',
      'bed',
      'patient',
      'admissionDate',
      'count',
      'averageMinutes',
      'maxMinutes',
      'billed',
      'collected',
      'outstanding',
      'quantity',
      'value'
    ];

    const available = new Set();

    report.rows.forEach((row) => {
      Object.keys(row || {}).forEach((key) => {
        if (!key.startsWith('__') && key !== '_id') {
          available.add(key);
        }
      });
    });

    const columns = [
      ...preferred.filter((key) => available.has(key)),
      ...[...available].filter((key) => !preferred.includes(key))
    ];

    rows.push([], ['Detailed MIS'], columns);

    report.rows.forEach((row) => {
      rows.push(columns.map((key) =>
        typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]
      ));
    });
  }

  Object.entries(report.series || {}).forEach(([name, values]) => {
    if (name === 'detail') return;

    rows.push([], [name, 'Dimension', 'Count', 'Quantity', 'Value']);

    (values || []).forEach((row) => {
      rows.push([
        '',
        typeof row._id === 'object' ? JSON.stringify(row._id) : row._id,
        row.count,
        row.quantity,
        row.value
      ]);
    });
  });

  return rows;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

// ============================================
// Render Export
// ============================================

async function renderExport(report, format) {
  const rows = flattenReport(report);
  const safeFilename = `${report.report?.key || 'mis'}-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'csv') {
    const output = Buffer.from(
      rows.map((row) => row.map(csvEscape).join(',')).join('\n'),
      'utf8'
    );

    return {
      output,
      filename: `${safeFilename}.csv`,
      mimeType: 'text/csv; charset=utf-8',
      rowCount: rows.length
    };
  }

  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('MIS Report');

    rows.forEach((row) => sheet.addRow(row));

    sheet.columns.forEach((column) => {
      column.width = Math.min(
        60,
        Math.max(
          12,
          ...(column.values || []).map((value) => String(value ?? '').length + 2)
        )
      );
    });

    sheet.getRow(1).font = { bold: true };

    const output = Buffer.from(await workbook.xlsx.writeBuffer());

    return {
      output,
      filename: `${safeFilename}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      rowCount: rows.length
    };
  }

  // PDF
  const output = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      bufferPages: true
    });

    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(report.report?.label || 'MIS Report');

    doc
      .moveDown(0.3)
      .fontSize(9)
      .font('Helvetica')
      .text(
        `Period: ${report.filters?.startDate || 'All'} to ${report.filters?.endDate || 'All'} | Generated: ${report.generatedAt}`
      );

    doc.moveDown();

    (report.cards || []).forEach((card) => {
      if (doc.y > 760) {
        doc.addPage();
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`${card.label}: `, { continued: true })
        .font('Helvetica')
        .text(String(card.value ?? '—'));
    });

    if (Array.isArray(report.rows) && report.rows.length) {
      if (doc.y > 700) {
        doc.addPage();
      }

      doc
        .moveDown()
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('Detailed MIS');

      report.rows.forEach((row) => {
        if (doc.y > 760) {
          doc.addPage();
        }

        const detail = Object.entries(row || {})
          .filter(([key, value]) =>
            key !== '_id' &&
            !key.startsWith('__') &&
            value !== undefined &&
            value !== null &&
            value !== ''
          )
          .map(([key, value]) =>
            `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`
          )
          .join(' | ');

        doc
          .font('Helvetica')
          .fontSize(7.5)
          .text(detail || '—');
      });
    }

    Object.entries(report.series || {}).forEach(([name, values]) => {
      if (name === 'detail') return;

      if (doc.y > 700) {
        doc.addPage();
      }

      doc
        .moveDown()
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(name.replace(/([A-Z])/g, ' $1'));

      (values || []).forEach((row) => {
        if (doc.y > 760) {
          doc.addPage();
        }

        doc
          .font('Helvetica')
          .fontSize(8)
          .text(
            `${typeof row._id === 'object' ? JSON.stringify(row._id) : row._id || 'Unknown'} | Count ${row.count ?? ''} | Qty ${row.quantity ?? ''} | Value ${row.value ?? ''}`
          );
      });
    });

    const range = doc.bufferedPageRange();

    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);

      doc
        .fontSize(7)
        .fillColor('#555')
        .text(
          `Page ${i + 1} of ${range.count}`,
          36,
          805,
          { align: 'right', width: 523 }
        );
    }

    doc.end();
  });

  return {
    output,
    filename: `${safeFilename}.pdf`,
    mimeType: 'application/pdf',
    rowCount: rows.length
  };
}

// ============================================
// Process Export Job
// ============================================

async function processExportJob(job) {
  try {
    job.status = 'Processing';
    await job.save();

    const report = await buildReport(job.reportKey, job.hospitalId, job.filters || {});
    const rendered = await renderExport(report, job.format);

    job.output = rendered.output;
    job.filename = rendered.filename;
    job.mimeType = rendered.mimeType;
    job.rowCount = rendered.rowCount;
    job.checksum = crypto.createHash('sha256').update(rendered.output).digest('hex');
    job.status = 'Completed';
    job.completedAt = new Date();
    job.expiresAt = new Date(Date.now() + 7 * 86400000);

    await job.save();
  } catch (error) {
    job.status = 'Failed';
    job.error = error.message;
    job.completedAt = new Date();
    await job.save();
  }

  return job;
}

// ============================================
// Schedule Helpers
// ============================================

function nextScheduleRun(schedule, from = new Date()) {
  const next = new Date(from);
  next.setSeconds(0, 0);

  const [hours, minutes] = String(schedule.timeOfDay || '07:00')
    .split(':')
    .map(Number);

  next.setHours(hours || 0, minutes || 0, 0, 0);

  if (schedule.frequency === 'Daily') {
    if (next <= from) {
      next.setDate(next.getDate() + 1);
    }
  } else if (schedule.frequency === 'Weekly') {
    const day = Number(schedule.dayOfWeek ?? 1);
    let delta = (day - next.getDay() + 7) % 7;

    if (delta === 0 && next <= from) {
      delta = 7;
    }

    next.setDate(next.getDate() + delta);
  } else {
    const day = Math.min(28, Math.max(1, Number(schedule.dayOfMonth || 1)));
    next.setDate(day);

    if (next <= from) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(day);
    }
  }

  return next;
}

// ============================================
// Controller Exports
// ============================================

exports.buildReport = buildReport;

exports.catalog = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);

    const overrides = await MISMetricDefinition.find({
      $or: [{ hospitalId }, { hospitalId: null }],
      isActive: true
    }).lean();

    const byCode = new Map(overrides.map((item) => [item.code, item]));
    const visibleCatalog = REPORT_CATALOG.filter((item) =>
      reportAllowedForUser(req.user, item.key)
    );

    res.json({
      success: true,
      data: visibleCatalog.map((item) => ({
        ...item,
        definition: byCode.get(item.key) || null
      }))
    });
  } catch (error) {
    next(error);
  }
};

exports.run = async (req, res, next) => {
  try {
    assertReportAccess(req, req.params.key);

    const data = await buildReport(
      req.params.key,
      requireHospitalId(req),
      req.query
    );

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.query = async (req, res, next) => {
  try {
    const key = req.body.reportKey || req.body.metricCode;

    if (!key) {
      return res.status(400).json({ error: 'reportKey is required' });
    }

    assertReportAccess(req, key);

    const data = await buildReport(
      key,
      requireHospitalId(req),
      req.body.filters || {}
    );

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.createExport = async (req, res, next) => {
  try {
    if (!['csv', 'xlsx', 'pdf'].includes(req.body.format)) {
      return res.status(400).json({ error: 'format must be csv, xlsx or pdf' });
    }

    assertReportAccess(req, req.body.reportKey);

    const job = await MISExportJob.create({
      hospitalId: requireHospitalId(req),
      requestedBy: req.user._id,
      reportKey: req.body.reportKey,
      filters: req.body.filters || {},
      format: req.body.format
    });

    await processExportJob(job);

    res.status(201).json({
      success: true,
      data: {
        _id: job._id,
        status: job.status,
        filename: job.filename,
        checksum: job.checksum,
        rowCount: job.rowCount,
        error: job.error
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.listExports = async (req, res, next) => {
  try {
    const data = await MISExportJob.find({
      hospitalId: requireHospitalId(req),
      requestedBy: req.user._id
    })
      .select('-output')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.getExport = async (req, res, next) => {
  try {
    const job = await MISExportJob.findOne({
      _id: req.params.id,
      hospitalId: requireHospitalId(req),
      requestedBy: req.user._id
    });

    if (!job) {
      return res.status(404).json({ error: 'Export not found' });
    }

    res.json({
      success: true,
      data: {
        _id: job._id,
        status: job.status,
        filename: job.filename,
        checksum: job.checksum,
        rowCount: job.rowCount,
        error: job.error,
        completedAt: job.completedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.downloadExport = async (req, res, next) => {
  try {
    const job = await MISExportJob.findOne({
      _id: req.params.id,
      hospitalId: requireHospitalId(req),
      requestedBy: req.user._id
    });

    if (!job || job.status !== 'Completed' || !job.output) {
      return res.status(404).json({ error: 'Completed export not found' });
    }

    res.setHeader('Content-Type', job.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
    res.setHeader('X-Content-SHA256', job.checksum);

    res.send(job.output);
  } catch (error) {
    next(error);
  }
};

exports.listSchedules = async (req, res, next) => {
  try {
    const data = await MISSchedule.find({
      hospitalId: requireHospitalId(req)
    }).sort({ createdAt: -1 });

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.createSchedule = async (req, res, next) => {
  try {
    assertReportAccess(req, req.body.reportKey);

    const payload = {
      ...req.body,
      hospitalId: requireHospitalId(req),
      createdBy: req.user._id
    };

    payload.nextRunAt = nextScheduleRun(payload);

    const record = await MISSchedule.create(payload);

    res.status(201).json({ success: true, data: record });
  } catch (error) {
    next(error);
  }
};

exports.updateSchedule = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);

    const existing = await MISSchedule.findOne({
      _id: req.params.id,
      hospitalId
    }).lean();

    if (!existing) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    if (req.body.reportKey) {
      assertReportAccess(req, req.body.reportKey);
    }

    const payload = {
      ...req.body,
      updatedBy: req.user._id
    };

    payload.nextRunAt = nextScheduleRun({
      ...existing,
      ...payload
    });

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

exports.deleteSchedule = async (req, res, next) => {
  try {
    const record = await MISSchedule.findOneAndDelete({
      _id: req.params.id,
      hospitalId: requireHospitalId(req)
    });

    if (!record) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

exports.createSnapshot = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const key = req.body.reportKey;
    const startDate = req.body.startDate;
    const endDate = req.body.endDate;

    assertReportAccess(req, key);

    const payload = await buildReport(
      key,
      hospitalId,
      {
        ...(req.body.filters || {}),
        startDate,
        endDate
      }
    );

    const checksum = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    const record = await MISSnapshot.findOneAndUpdate(
      {
        hospitalId,
        reportKey: key,
        grain: req.body.grain || 'day',
        periodStart: new Date(startDate)
      },
      {
        $set: {
          periodEnd: new Date(endDate || startDate),
          payload,
          sourceChecksum: checksum,
          generatedAt: new Date(),
          status: 'Fresh',
          errors: []
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    res.status(201).json({ success: true, data: record });
  } catch (error) {
    next(error);
  }
};

exports.listSnapshots = async (req, res, next) => {
  try {
    const filter = { hospitalId: requireHospitalId(req) };

    if (req.query.reportKey) {
      filter.reportKey = req.query.reportKey;
    }

    const data = await MISSnapshot.find(filter)
      .select('-payload')
      .sort({ generatedAt: -1 })
      .limit(100);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

exports.dataQuality = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const hospital = oid(hospitalId);
    const staleCutoff = new Date(Date.now() - 48 * 3600000);

    const checks = await Promise.all([
      count('OTRequest', { hospitalId: hospital, admissionId: null })
        .then((value) => ({
          key: 'ot_missing_admission',
          label: 'OT cases missing admission linkage',
          value,
          status: value ? 'Exception' : 'Pass'
        })),
      count('EncounterDocument', {
        hospitalId: hospital,
        status: { $in: ['Draft', 'Completed'] },
        signatureStatus: { $ne: 'Signed' }
      }).then((value) => ({
        key: 'unsigned_documents',
        label: 'Draft/completed unsigned documents',
        value,
        status: value ? 'Warning' : 'Pass'
      })),
      count('InventoryLot', { hospitalId: hospital, totalOnHand: { $lt: 0 } })
        .then((value) => ({
          key: 'negative_lot_balance',
          label: 'Lots with negative on-hand balance',
          value,
          status: value ? 'Exception' : 'Pass'
        })),
      count('MISSnapshot', {
        hospitalId: hospital,
        generatedAt: { $lt: staleCutoff }
      }).then((value) => ({
        key: 'stale_snapshots',
        label: 'MIS snapshots older than 48 hours',
        value,
        status: value ? 'Warning' : 'Pass'
      }))
    ]);

    const overall = checks.some((x) => x.status === 'Exception')
      ? 'Exception'
      : checks.some((x) => x.status === 'Warning')
        ? 'Warning'
        : 'Pass';

    res.json({
      success: true,
      data: {
        checkedAt: new Date(),
        checks,
        overall
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.processExportJob = processExportJob;
exports.nextScheduleRun = nextScheduleRun;