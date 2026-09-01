const mongoose = require('mongoose');
const { hospitalDateKey } = require('../utils/hospitalDateTime');
const { operationDateKey } = require('../utils/operationTimeContext');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const IPDCharge = require('../models/IPDCharge');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const Hospital = require('../models/Hospital');
const { normalizeFinancialLine } = require('../utils/financialLine');

const asNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const idString = (value) => String(value?._id || value || '');
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patientDisplayName = (patient = {}) => (
  [patient.first_name || patient.firstName, patient.middle_name || patient.middleName, patient.last_name || patient.lastName].filter(Boolean).join(' ')
  || patient.name
  || 'Patient'
);

const latestDate = (...values) => {
  const dates = values.flat().filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime()));
  return dates.length ? new Date(Math.max(...dates.map((value) => value.getTime()))) : null;
};

const billOutstanding = (bill) => asNumber(
  bill.balance_due !== undefined
    ? bill.balance_due
    : Math.max(0, asNumber(bill.total_amount) - asNumber(bill.paid_amount))
);

const invoiceOutstanding = (invoice) => asNumber(
  invoice.balance_due !== undefined
    ? invoice.balance_due
    : Math.max(0, asNumber(invoice.total) - asNumber(invoice.amount_paid))
);

function chargeSection(charge = {}) {
  const type = String(charge.chargeType || '').toLowerCase();
  const source = String(charge.sourceModule || '').toLowerCase();
  const description = String(charge.description || '').toLowerCase();
  if (type.includes('bed') || source === 'bed' || description.includes('room')) return 'Room & Bed Charges';
  if (type.includes('doctor') || type.includes('consult') || source.includes('doctor')) return 'Doctor Charges';
  if (type.includes('surgery') || type.includes('ot') || source.includes('ot')) return 'Surgery / OT Charges';
  if (type.includes('procedure') || source.includes('procedure')) return 'Procedure Charges';
  if (type.includes('lab') || source === 'lab' || source.includes('pathology')) return 'Laboratory';
  if (type.includes('radiology') || source.includes('radiology') || source.includes('imaging')) return 'Radiology';
  if (type.includes('pharmacy') || type.includes('consum') || source.includes('pharmacy') || description.includes('medicine')) return 'Consumables';
  return 'Miscellaneous';
}

function dateKey(value) {
  if (!value) return 'Undated';
  try { return hospitalDateKey(value); } catch { return 'Undated'; }
}

function groupCharges(charges = []) {
  const sections = new Map();
  charges.forEach((charge) => {
    const section = chargeSection(charge);
    const day = dateKey(charge.chargeDate || charge.createdAt);
    if (!sections.has(section)) sections.set(section, new Map());
    const dates = sections.get(section);
    if (!dates.has(day)) dates.set(day, []);
    dates.get(day).push(charge);
  });

  return Array.from(sections.entries()).map(([section, dates]) => ({
    section,
    total: Array.from(dates.values()).flat().reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0),
    dates: Array.from(dates.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, items]) => ({
        date,
        total: items.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0),
        items
      }))
  }));
}

function billingPatientLookup() {
  return {
    $lookup: {
      from: Patient.collection.name,
      localField: 'patientId',
      foreignField: '_id',
      pipeline: [{ $project: { first_name: 1, middle_name: 1, last_name: 1, name: 1, patientId: 1, uhid: 1, phone: 1, gender: 1, dob: 1, age: 1 } }],
      as: '_patient'
    }
  };
}

function billingSearchStage(search) {
  const term = String(search || '').trim();
  if (!term) return null;
  const regex = new RegExp(escapeRegex(term), 'i');
  return {
    $match: {
      $or: [
        { patientName: regex }, { uhid: regex }, { phone: regex }, { admissionNumber: regex }
      ]
    }
  };
}

function invoiceUpdateExpression(prefix = '$$invoice') {
  return {
    $ifNull: [
      `${prefix}.updated_at`,
      { $ifNull: [`${prefix}.updatedAt`, { $ifNull: [`${prefix}.created_at`, `${prefix}.createdAt`] }] }
    ]
  };
}

async function aggregateIpdBillingRows({ hospitalObjectId, search, startDate = '', endDate = '', rowLimit = null, skip = 0 }) {
  const pipeline = [
    { $match: { hospitalId: hospitalObjectId } },
    { $set: { patientId: '$patientId' } },
    billingPatientLookup(),
    { $set: { _patient: { $arrayElemAt: ['$_patient', 0] } } },
    {
      $lookup: {
        from: Invoice.collection.name,
        let: { admissionId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$hospital_id', hospitalObjectId] },
            { $eq: ['$admission_id', '$$admissionId'] },
            { $ne: ['$is_deleted', true] }
          ] } } },
          { $project: { total: 1, amount_paid: 1, balance_due: 1, status: 1, updated_at: 1, updatedAt: 1, created_at: 1, createdAt: 1 } }
        ],
        as: '_invoices'
      }
    },
    {
      $lookup: {
        from: IPDCharge.collection.name,
        let: { admissionId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$hospitalId', hospitalObjectId] },
            { $eq: ['$admissionId', '$$admissionId'] },
            { $ne: ['$status', 'VOIDED'] }
          ] } } },
          { $project: { netAmount: 1, amount: 1, isBilled: 1, status: 1, updatedAt: 1, chargeDate: 1, createdAt: 1 } }
        ],
        as: '_charges'
      }
    },
    {
      $lookup: {
        from: require('../models/Doctor').collection.name,
        localField: 'primaryDoctorId', foreignField: '_id',
        pipeline: [{ $project: { firstName: 1, lastName: 1, first_name: 1, last_name: 1, name: 1 } }],
        as: '_doctor'
      }
    },
    {
      $lookup: {
        from: require('../models/Ward').collection.name,
        localField: 'wardId', foreignField: '_id',
        pipeline: [{ $project: { name: 1, wardName: 1 } }], as: '_ward'
      }
    },
    {
      $lookup: {
        from: require('../models/Bed').collection.name,
        localField: 'bedId', foreignField: '_id',
        pipeline: [{ $project: { bedNumber: 1, bed_number: 1, name: 1 } }], as: '_bed'
      }
    },
    {
      $set: {
        _doctor: { $arrayElemAt: ['$_doctor', 0] }, _ward: { $arrayElemAt: ['$_ward', 0] }, _bed: { $arrayElemAt: ['$_bed', 0] },
        _issuedTotal: { $sum: '$_invoices.total' },
        _chargeTotal: { $sum: { $map: { input: '$_charges', as: 'c', in: { $ifNull: ['$$c.netAmount', '$$c.amount'] } } } },
        _unbilled: { $filter: { input: '$_charges', as: 'c', cond: { $and: [{ $ne: ['$$c.isBilled', true] }, { $ne: ['$$c.status', 'INVOICED'] }] } } },
        _invoiceOutstanding: { $sum: { $map: { input: '$_invoices', as: 'i', in: {
          $cond: [
            { $ne: [{ $type: '$$i.balance_due' }, 'missing'] },
            { $ifNull: ['$$i.balance_due', 0] },
            { $max: [0, { $subtract: [{ $ifNull: ['$$i.total', 0] }, { $ifNull: ['$$i.amount_paid', 0] }] }] }
          ]
        } } } }
      }
    },
    {
      $set: {
        _unbilledTotal: { $sum: { $map: { input: '$_unbilled', as: 'c', in: { $ifNull: ['$$c.netAmount', '$$c.amount'] } } } },
        _invoiceDates: { $map: { input: '$_invoices', as: 'invoice', in: invoiceUpdateExpression('$$invoice') } },
        _chargeDates: { $map: { input: '$_charges', as: 'charge', in: { $ifNull: ['$$charge.updatedAt', { $ifNull: ['$$charge.chargeDate', '$$charge.createdAt'] }] } } }
      }
    },
    {
      $project: {
        _id: 0,
        encounterType: { $literal: 'IPD' },
        rowKey: { $concat: ['ipd:', { $toString: '$_id' }] },
        patientId: { $toString: '$_patient._id' },
        patientName: {
          $let: {
            vars: { fullName: { $trim: { input: { $concat: [
              { $ifNull: ['$_patient.first_name', ''] }, ' ', { $ifNull: ['$_patient.middle_name', ''] }, ' ', { $ifNull: ['$_patient.last_name', ''] }
            ] } } } },
            in: { $cond: [{ $gt: [{ $strLenCP: '$$fullName' }, 0] }, '$$fullName', { $ifNull: ['$_patient.name', 'Patient'] }] }
          }
        },
        uhid: { $ifNull: ['$_patient.uhid', { $ifNull: ['$_patient.patientId', '—'] }] },
        phone: { $ifNull: ['$_patient.phone', ''] },
        admissionId: { $toString: '$_id' },
        admissionNumber: { $ifNull: ['$admissionNumber', { $ifNull: ['$shipNumber', '—'] }] },
        admissionStatus: { $ifNull: ['$status', 'Admitted'] },
        consultant: {
          $let: {
            vars: { fullName: { $trim: { input: { $concat: [
              { $ifNull: ['$_doctor.firstName', { $ifNull: ['$_doctor.first_name', { $ifNull: ['$_doctor.name', ''] }] }] }, ' ',
              { $ifNull: ['$_doctor.lastName', { $ifNull: ['$_doctor.last_name', ''] }] }
            ] } } } },
            in: { $cond: [{ $gt: [{ $strLenCP: '$$fullName' }, 0] }, '$$fullName', 'Patient'] }
          }
        },
        ward: { $ifNull: ['$_ward.name', { $ifNull: ['$_ward.wardName', ''] }] },
        bed: { $ifNull: ['$_bed.bedNumber', { $ifNull: ['$_bed.bed_number', { $ifNull: ['$_bed.name', ''] }] }] },
        // Invoice/charge documents are authoritative for the billing worklist.
        // Admission.totalBillAmount/dueAmount are cached projections and can lag
        // after settlement, advance utilisation, credit notes or refunds. Reusing
        // those caches here was one source of /billing vs IPD summary mismatches.
        totalBill: {
          $cond: [
            { $gt: ['$_issuedTotal', 0] },
            { $add: ['$_issuedTotal', '$_unbilledTotal'] },
            '$_chargeTotal'
          ]
        },
        outstandingAmount: { $add: ['$_invoiceOutstanding', '$_unbilledTotal'] },
        invoiceCount: { $size: '$_invoices' }, chargeCount: { $size: '$_charges' },
        lastUpdated: { $max: { $concatArrays: [[{ $ifNull: ['$updatedAt', '$admissionDate'] }], '$_invoiceDates', '$_chargeDates'] } }
      }
    }
  ];
  const searchStage = billingSearchStage(search);
  if (searchStage) pipeline.push(searchStage);
  const dateStage = billingLastUpdatedStage(startDate, endDate);
  if (dateStage) pipeline.push(dateStage);
  pipeline.push({ $sort: { lastUpdated: -1 } });
  pipeline.push({ $facet: {
    rows: [{ $skip: skip }, ...(rowLimit ? [{ $limit: rowLimit }] : [])],
    count: [{ $count: 'value' }]
  } });
  const [result = {}] = await IPDAdmission.aggregate(pipeline).allowDiskUse(true);
  return { rows: result.rows || [], count: result.count?.[0]?.value || 0 };
}

async function aggregateOpdBillingRows({ hospitalObjectId, search, startDate = '', endDate = '', rowLimit = null, skip = 0 }) {
  const pipeline = [
    { $match: { hospital_id: hospitalObjectId, is_deleted: { $ne: true }, $or: [{ admission_id: null }, { admission_id: { $exists: false } }] } },
    {
      $set: {
        _billOutstanding: {
          $cond: [
            { $ne: [{ $type: '$balance_due' }, 'missing'] },
            { $ifNull: ['$balance_due', 0] },
            { $max: [0, { $subtract: [{ $ifNull: ['$total_amount', 0] }, { $ifNull: ['$paid_amount', 0] }] }] }
          ]
        },
        _billUpdated: { $ifNull: ['$updatedAt', { $ifNull: ['$createdAt', '$generated_at'] }] }
      }
    },
    {
      $group: {
        _id: '$patient_id', totalBill: { $sum: { $ifNull: ['$total_amount', 0] } },
        outstandingAmount: { $sum: '$_billOutstanding' }, billCount: { $sum: 1 }, lastUpdated: { $max: '$_billUpdated' }
      }
    },
    { $match: { _id: { $ne: null } } },
    { $set: { patientId: '$_id' } },
    billingPatientLookup(),
    { $set: { _patient: { $arrayElemAt: ['$_patient', 0] } } },
    {
      $lookup: {
        from: Invoice.collection.name,
        let: { patientId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$hospital_id', hospitalObjectId] }, { $eq: ['$patient_id', '$$patientId'] },
            { $ne: ['$is_deleted', true] }, { $eq: [{ $ifNull: ['$admission_id', null] }, null] }
          ] } } },
          { $project: { updated_at: 1, updatedAt: 1, created_at: 1, createdAt: 1 } }
        ],
        as: '_invoices'
      }
    },
    {
      $project: {
        _id: 0, encounterType: { $literal: 'OPD' }, rowKey: { $concat: ['opd:', { $toString: '$_id' }] },
        patientId: { $toString: '$_id' },
        patientName: {
          $let: {
            vars: { fullName: { $trim: { input: { $concat: [
              { $ifNull: ['$_patient.first_name', ''] }, ' ', { $ifNull: ['$_patient.middle_name', ''] }, ' ', { $ifNull: ['$_patient.last_name', ''] }
            ] } } } },
            in: { $cond: [{ $gt: [{ $strLenCP: '$$fullName' }, 0] }, '$$fullName', { $ifNull: ['$_patient.name', 'Patient'] }] }
          }
        },
        uhid: { $ifNull: ['$_patient.uhid', { $ifNull: ['$_patient.patientId', '—'] }] },
        phone: { $ifNull: ['$_patient.phone', ''] },
        admissionId: { $literal: null }, admissionNumber: { $literal: 'OPD' }, admissionStatus: { $literal: 'OPD' },
        totalBill: 1, outstandingAmount: 1, billCount: 1, invoiceCount: { $size: '$_invoices' }, chargeCount: { $literal: 0 },
        lastUpdated: { $max: { $concatArrays: [
          ['$lastUpdated'],
          { $map: { input: '$_invoices', as: 'invoice', in: invoiceUpdateExpression('$$invoice') } }
        ] } }
      }
    }
  ];
  const searchStage = billingSearchStage(search);
  if (searchStage) pipeline.push(searchStage);
  const dateStage = billingLastUpdatedStage(startDate, endDate);
  if (dateStage) pipeline.push(dateStage);
  pipeline.push({ $sort: { lastUpdated: -1 } });
  pipeline.push({ $facet: {
    rows: [{ $skip: skip }, ...(rowLimit ? [{ $limit: rowLimit }] : [])],
    count: [{ $count: 'value' }]
  } });
  const [result = {}] = await Bill.aggregate(pipeline).allowDiskUse(true);
  return { rows: result.rows || [], count: result.count?.[0]?.value || 0 };
}

async function getGlobalBillingCounts(hospitalObjectId) {
  const [ipd, opdRows] = await Promise.all([
    IPDAdmission.countDocuments({ hospitalId: hospitalObjectId }),
    Bill.aggregate([
      { $match: { hospital_id: hospitalObjectId, is_deleted: { $ne: true }, $or: [{ admission_id: null }, { admission_id: { $exists: false } }] } },
      { $group: { _id: '$patient_id' } },
      { $match: { _id: { $ne: null } } },
      { $count: 'value' }
    ])
  ]);
  const opd = opdRows?.[0]?.value || 0;
  return { all: ipd + opd, ipd, opd };
}


function utcDateRange(startDate, endDate, { requireBoth = false } = {}) {
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  if (requireBoth && (!start || !end)) return null;
  const range = {};
  if (start) range.$gte = new Date(`${start}T00:00:00.000Z`);
  if (end) {
    const endExclusive = new Date(`${end}T00:00:00.000Z`);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    range.$lt = endExclusive;
  }
  return Object.keys(range).length ? range : null;
}

function billingLastUpdatedStage(startDate, endDate) {
  const range = utcDateRange(startDate, endDate);
  return range ? { $match: { lastUpdated: range } } : null;
}

function transactionSearchStage(search) {
  const term = String(search || '').trim();
  if (!term) return null;
  const regex = new RegExp(escapeRegex(term), 'i');
  return { $match: { $or: [
    { patientName: regex },
    { _idText: regex },
    { invoice_number: regex },
    { bill_number: regex }
  ] } };
}

function transactionStatusStage(status) {
  const value = String(status || '').trim();
  if (!value || value === 'All') return null;
  return { $match: { status: value } };
}

function transactionDateStage(startDate, endDate) {
  // Preserve the existing dashboard behavior: transaction date filtering only
  // activates after BOTH bounds are selected.
  const range = utcDateRange(startDate, endDate, { requireBoth: true });
  return range ? { $match: { displayDate: range } } : null;
}

function patientNameExpression(patientPath = '$_patient', fallbackPath = null) {
  return {
    $let: {
      vars: { fullName: { $trim: { input: { $concat: [
        { $ifNull: [`${patientPath}.first_name`, ''] }, ' ',
        { $ifNull: [`${patientPath}.middle_name`, ''] }, ' ',
        { $ifNull: [`${patientPath}.last_name`, ''] }
      ] } } } },
      in: {
        $cond: [
          { $gt: [{ $strLenCP: '$$fullName' }, 0] },
          '$$fullName',
          fallbackPath ? { $ifNull: [fallbackPath, 'Unknown Patient'] } : 'Unknown Patient'
        ]
      }
    }
  };
}

async function aggregateBillTransactions({ hospitalObjectId, search, status, startDate, endDate, scope = 'all', rowLimit = null }) {
  const baseMatch = { hospital_id: hospitalObjectId, is_deleted: { $ne: true } };
  if (scope === 'opd') baseMatch.$or = [{ admission_id: null }, { admission_id: { $exists: false } }];
  const pipeline = [
    { $match: baseMatch },
    {
      $lookup: {
        from: Patient.collection.name,
        localField: 'patient_id',
        foreignField: '_id',
        pipeline: [{ $project: { first_name: 1, middle_name: 1, last_name: 1, patientId: 1, uhid: 1 } }],
        as: '_patient'
      }
    },
    { $set: { _patient: { $arrayElemAt: ['$_patient', 0] } } },
    {
      $project: {
        _id: 1,
        _idText: { $toString: '$_id' },
        _sourceType: { $literal: 'bill' },
        patient_id: {
          _id: '$_patient._id', first_name: '$_patient.first_name', middle_name: '$_patient.middle_name',
          last_name: '$_patient.last_name', patientId: '$_patient.patientId', uhid: '$_patient.uhid'
        },
        patientId: { $toString: '$patient_id' },
        patientName: patientNameExpression('$_patient'),
        documentLabel: {
          $cond: [
            { $ne: [{ $ifNull: ['$admission_id', null] }, null] }, 'IPD Bill',
            { $cond: [{ $eq: ['$is_pharmacy_bill', true] }, 'Pharmacy Bill', 'OPD Bill'] }
          ]
        },
        bill_number: 1,
        invoice_number: { $literal: null },
        invoice_type: { $literal: null },
        admission_id: 1,
        status: 1,
        displayAmount: { $ifNull: ['$total_amount', 0] },
        displayDate: { $ifNull: ['$generated_at', '$createdAt'] },
        itemDescriptions: { $slice: [{ $ifNull: ['$items.description', []] }, 5] },
        notes: 1,
        total_amount: { $ifNull: ['$total_amount', 0] },
        paid_amount: { $ifNull: ['$paid_amount', 0] },
        balance_due: {
          $ifNull: ['$balance_due', { $max: [0, { $subtract: [{ $ifNull: ['$total_amount', 0] }, { $ifNull: ['$paid_amount', 0] }] }] }]
        },
        payment_method: { $ifNull: ['$payment_method', 'N/A'] },
        deletion_request: 1,
        generated_at: 1,
        createdAt: 1
      }
    }
  ];
  [transactionSearchStage(search), transactionStatusStage(status), transactionDateStage(startDate, endDate)]
    .filter(Boolean).forEach((stage) => pipeline.push(stage));
  pipeline.push({ $sort: { displayDate: -1, _id: -1 } });
  pipeline.push({ $facet: {
    rows: rowLimit ? [{ $limit: rowLimit }] : [],
    count: [{ $count: 'value' }]
  } });
  const [result = {}] = await Bill.aggregate(pipeline).allowDiskUse(true);
  const rows = (result.rows || []).map((row) => ({
    ...row,
    displayDescription: (row.itemDescriptions || []).filter(Boolean).join(', ') || row.notes || 'Bill items'
  }));
  return { rows, count: result.count?.[0]?.value || 0 };
}

async function aggregateInvoiceTransactions({ hospitalObjectId, search, status, startDate, endDate, scope = 'all', rowLimit = null }) {
  const baseMatch = { hospital_id: hospitalObjectId, is_deleted: { $ne: true } };
  if (scope === 'opd') {
    baseMatch.$and = [
      { $or: [{ admission_id: null }, { admission_id: { $exists: false } }] },
      { invoice_type: { $ne: 'Purchase' } }
    ];
  }
  const pipeline = [
    { $match: baseMatch },
    {
      $lookup: {
        from: Patient.collection.name,
        localField: 'patient_id',
        foreignField: '_id',
        pipeline: [{ $project: { first_name: 1, middle_name: 1, last_name: 1, patientId: 1, uhid: 1 } }],
        as: '_patient'
      }
    },
    { $set: { _patient: { $arrayElemAt: ['$_patient', 0] } } },
    {
      $project: {
        _id: 1,
        _idText: { $toString: '$_id' },
        _sourceType: { $literal: 'invoice' },
        patient_id: {
          _id: '$_patient._id', first_name: '$_patient.first_name', middle_name: '$_patient.middle_name',
          last_name: '$_patient.last_name', patientId: '$_patient.patientId', uhid: '$_patient.uhid'
        },
        patientId: { $toString: '$patient_id' },
        patientName: patientNameExpression('$_patient', '$customer_name'),
        documentLabel: { $concat: [{ $ifNull: ['$invoice_type', 'Patient'] }, ' Invoice'] },
        invoice_number: 1,
        bill_number: { $literal: null },
        invoice_type: 1,
        bill_id: 1,
        admission_id: 1,
        status: { $cond: [{ $eq: ['$status', 'Partial'] }, 'Partially Paid', '$status'] },
        displayAmount: { $ifNull: ['$total', 0] },
        displayDate: { $ifNull: ['$issue_date', { $ifNull: ['$issued_at', { $ifNull: ['$created_at', '$createdAt'] }] }] },
        itemDescriptions: { $slice: [{ $ifNull: ['$service_items.description', []] }, 5] },
        total_amount: { $ifNull: ['$total', 0] },
        total: { $ifNull: ['$total', 0] },
        paid_amount: { $ifNull: ['$amount_paid', 0] },
        amount_paid: { $ifNull: ['$amount_paid', 0] },
        balance_due: {
          $ifNull: ['$balance_due', { $max: [0, { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$amount_paid', 0] }] }] }]
        },
        payment_method: { $ifNull: [{ $arrayElemAt: ['$payment_history.method', -1] }, 'N/A'] },
        issue_date: 1,
        issued_at: 1,
        created_at: 1,
        createdAt: 1
      }
    }
  ];
  [transactionSearchStage(search), transactionStatusStage(status), transactionDateStage(startDate, endDate)]
    .filter(Boolean).forEach((stage) => pipeline.push(stage));
  pipeline.push({ $sort: { displayDate: -1, _id: -1 } });
  pipeline.push({ $facet: {
    rows: rowLimit ? [{ $limit: rowLimit }] : [],
    count: [{ $count: 'value' }]
  } });
  const [result = {}] = await Invoice.aggregate(pipeline).allowDiskUse(true);
  const rows = (result.rows || []).map((row) => ({
    ...row,
    displayDescription: (row.itemDescriptions || []).filter(Boolean).join(', ') || `${row.invoice_type || 'Patient'} invoice ${row.invoice_number || ''}`.trim()
  }));
  return { rows, count: result.count?.[0]?.value || 0 };
}

async function getBillingDashboardStats(hospitalObjectId) {
  const today = operationDateKey();
  const [result = {}] = await Bill.aggregate([
    { $match: { hospital_id: hospitalObjectId, is_deleted: { $ne: true } } },
    {
      $project: {
        total_amount: { $ifNull: ['$total_amount', 0] },
        paid_amount: { $ifNull: ['$paid_amount', 0] },
        balance_due: {
          $ifNull: ['$balance_due', { $max: [0, { $subtract: [{ $ifNull: ['$total_amount', 0] }, { $ifNull: ['$paid_amount', 0] }] }] }]
        },
        status: 1,
        paid_at: 1,
        todayPayments: {
          $sum: {
            $map: {
              input: { $ifNull: ['$payments', []] },
              as: 'payment',
              in: {
                $cond: [
                  { $eq: [{ $substrBytes: [{ $ifNull: [{ $toString: '$$payment.date' }, ''] }, 0, 10] }, today] },
                  { $ifNull: ['$$payment.amount', 0] },
                  0
                ]
              }
            }
          }
        }
      }
    },
    {
      $group: {
        _id: null,
        totalOutstanding: { $sum: { $cond: [{ $in: ['$status', ['Pending', 'Partially Paid', 'Generated']] }, '$balance_due', 0] } },
        collectedToday: { $sum: {
          $cond: [
            { $gt: ['$todayPayments', 0] }, '$todayPayments',
            { $cond: [
              { $eq: [{ $substrBytes: [{ $ifNull: [{ $toString: '$paid_at' }, ''] }, 0, 10] }, today] }, '$paid_amount', 0
            ] }
          ]
        } },
        overdueCount: { $sum: { $cond: [{ $in: ['$status', ['Pending', 'Partially Paid']] }, 1, 0] } },
        totalCollected: { $sum: {
          $cond: [
            { $gt: ['$paid_amount', 0] }, '$paid_amount',
            { $cond: [{ $eq: ['$status', 'Paid'] }, '$total_amount', 0] }
          ]
        } },
        totalBilled: { $sum: { $cond: [{ $in: ['$status', ['Paid', 'Pending', 'Partially Paid']] }, '$total_amount', 0] } }
      }
    }
  ]);
  return {
    totalOutstanding: asNumber(result.totalOutstanding),
    collectedToday: asNumber(result.collectedToday),
    overdueCount: asNumber(result.overdueCount),
    totalCollected: asNumber(result.totalCollected),
    totalBilled: asNumber(result.totalBilled)
  };
}

async function listBillingTransactions({ hospitalId, search = '', status = 'All', startDate = '', endDate = '', scope = 'all', limit = 50, page = 1 }) {
  const hospitalObjectId = new mongoose.Types.ObjectId(String(hospitalId));
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const skip = (safePage - 1) * safeLimit;
  const candidateLimit = safePage * safeLimit;
  const normalizedScope = scope === 'opd' ? 'opd' : 'all';

  const [bills, invoices, stats, openIpdCount, patientCounts] = await Promise.all([
    aggregateBillTransactions({ hospitalObjectId, search, status, startDate, endDate, scope: normalizedScope, rowLimit: candidateLimit }),
    aggregateInvoiceTransactions({ hospitalObjectId, search, status, startDate, endDate, scope: normalizedScope, rowLimit: candidateLimit }),
    getBillingDashboardStats(hospitalObjectId),
    IPDAdmission.countDocuments({ hospitalId: hospitalObjectId, status: { $ne: 'Cancelled' }, financialClearanceStatus: { $ne: 'cleared' } }),
    getGlobalBillingCounts(hospitalObjectId)
  ]);

  const rows = [...bills.rows, ...invoices.rows]
    .sort((left, right) => {
      const dateDiff = new Date(right.displayDate || 0) - new Date(left.displayDate || 0);
      return dateDiff || String(right._id).localeCompare(String(left._id));
    })
    .slice(skip, skip + safeLimit)
    .map(({ itemDescriptions, _idText, ...row }) => ({ ...row, _worklistCompact: true }));
  const total = bills.count + invoices.count;
  return {
    rows,
    stats,
    openIpdCount,
    patientCounts,
    pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.max(1, Math.ceil(total / safeLimit)) }
  };
}

async function listPatientBillingSummaries({ hospitalId, type = 'all', search = '', startDate = '', endDate = '', limit = 250, page = 1 }) {
  const hospitalObjectId = new mongoose.Types.ObjectId(String(hospitalId));
  // Preserve the legacy endpoint's accepted response size for callers that have
  // not yet migrated, while new high-traffic screens use much smaller pages.
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 250));
  const safePage = Math.max(1, Number(page) || 1);
  const skip = (safePage - 1) * safeLimit;
  const countsPromise = getGlobalBillingCounts(hospitalObjectId);

  if (type === 'ipd') {
    const [result, counts] = await Promise.all([
      aggregateIpdBillingRows({ hospitalObjectId, search, startDate, endDate, rowLimit: safeLimit, skip }),
      countsPromise
    ]);
    return {
      rows: result.rows,
      counts,
      pagination: { page: safePage, limit: safeLimit, total: result.count, totalPages: Math.max(1, Math.ceil(result.count / safeLimit)) }
    };
  }
  if (type === 'opd') {
    const [result, counts] = await Promise.all([
      aggregateOpdBillingRows({ hospitalObjectId, search, startDate, endDate, rowLimit: safeLimit, skip }),
      countsPromise
    ]);
    return {
      rows: result.rows,
      counts,
      pagination: { page: safePage, limit: safeLimit, total: result.count, totalPages: Math.max(1, Math.ceil(result.count / safeLimit)) }
    };
  }

  // Fetch only enough sorted candidates from each encounter type to construct
  // the requested combined page. This keeps Node memory bounded while preserving
  // the exact cross-type lastUpdated ordering used by the previous implementation.
  const candidateLimit = safePage * safeLimit;
  const [ipd, opd, counts] = await Promise.all([
    aggregateIpdBillingRows({ hospitalObjectId, search, startDate, endDate, rowLimit: candidateLimit, skip: 0 }),
    aggregateOpdBillingRows({ hospitalObjectId, search, startDate, endDate, rowLimit: candidateLimit, skip: 0 }),
    countsPromise
  ]);
  const combined = [...ipd.rows, ...opd.rows]
    .sort((left, right) => new Date(right.lastUpdated || 0) - new Date(left.lastUpdated || 0));
  const filteredTotal = ipd.count + opd.count;
  return {
    rows: combined.slice(skip, skip + safeLimit),
    counts,
    pagination: { page: safePage, limit: safeLimit, total: filteredTotal, totalPages: Math.max(1, Math.ceil(filteredTotal / safeLimit)) }
  };
}

async function getPatientBillingDetails({ hospitalId, patientId, admissionId, appointmentId = null }) {
  const [patient, hospital] = await Promise.all([
    Patient.findOne({ _id: patientId, hospitalId }).lean(),
    Hospital.findById(hospitalId).select('hospitalName name address city state pinCode contact phone email logo').lean()
  ]);
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }

  const billFilter = { hospital_id: hospitalId, patient_id: patientId, is_deleted: { $ne: true } };
  const invoiceFilter = { hospital_id: hospitalId, patient_id: patientId, is_deleted: { $ne: true } };
  const chargeFilter = { hospitalId, patientId, status: { $ne: 'VOIDED' } };
  let admission = null;
  if (admissionId) {
    billFilter.admission_id = admissionId;
    invoiceFilter.admission_id = admissionId;
    chargeFilter.admissionId = admissionId;
    admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('primaryDoctorId', 'firstName lastName first_name last_name name')
      .populate('departmentId', 'name')
      .populate('wardId', 'name wardName')
      .populate('bedId', 'bedNumber bed_number name')
      .lean();
    if (!admission) {
      const error = new Error('IPD admission not found');
      error.statusCode = 404;
      throw error;
    }
  } else {
    const opdOnly = [{ admission_id: { $exists: false } }, { admission_id: null }];
    if (appointmentId) {
      // New Desk bills carry appointment_id directly. A short-lived legacy Desk
      // bug still wrote the stable appointment sourceLineKey but lost the top-level
      // appointment_id, so include that canonical source linkage for read compatibility.
      billFilter.$and = [
        { $or: opdOnly },
        {
          $or: [
            { appointment_id: appointmentId },
            { 'items.source_snapshot.sourceLineKey': { $regex: `^appointment:${escapeRegex(appointmentId)}:` } },
            { 'items.source_snapshot.originModule': 'Appointment', 'items.source_snapshot.sourceId': String(appointmentId) }
          ]
        }
      ];
    } else {
      billFilter.$or = opdOnly;
    }
    invoiceFilter.$or = [{ admission_id: { $exists: false } }, { admission_id: null }];
    // OPD details intentionally exclude IPD charges.
    chargeFilter.$or = [{ admissionId: { $exists: false } }, { admissionId: null }];
  }

  const transactionFilter = { hospitalId, patientId, status: 'POSTED' };
  const advanceFilter = { hospitalId, patientId, status: 'POSTED' };
  if (admissionId) {
    transactionFilter.admissionId = admissionId;
    advanceFilter.admissionId = admissionId;
    // IPD billing must reconcile only the shared IPD patient-advance wallet.
    // Pharmacy maintains a separate PHARMACY_IPD wallet and including it here
    // makes the same credit appear twice across IPD/pharmacy documents.
    advanceFilter.walletType = 'IPD_SHARED';
  } else {
    transactionFilter.$or = [{ admissionId: { $exists: false } }, { admissionId: null }];
    advanceFilter.$or = [{ admissionId: { $exists: false } }, { admissionId: null }];
    advanceFilter.walletType = 'OPD_SHARED';
  }

  const [bills, rawInvoices, charges, rawTransactions, advanceLedger] = await Promise.all([
    Bill.find(billFilter)
      .populate({
        path: 'appointment_id',
        select: 'appointmentId appointment_date start_time department_id doctor_id status',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName first_name last_name name' },
          { path: 'department_id', select: 'name' }
        ]
      })
      .sort({ generated_at: -1, createdAt: -1 })
      .lean(),
    Invoice.find(invoiceFilter)
      .populate({
        path: 'appointment_id',
        select: 'appointmentId appointment_date start_time department_id doctor_id status',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName first_name last_name name' },
          { path: 'department_id', select: 'name' }
        ]
      })
      .sort({ issue_date: -1, created_at: -1 })
      .lean(),
    admissionId ? IPDCharge.find(chargeFilter).sort({ chargeDate: 1, createdAt: 1 }).lean() : Promise.resolve([]),
    FinancialTransaction.find(transactionFilter)
      .populate('invoiceId', 'invoice_number bill_number invoice_type admission_id appointment_id status issue_date created_at createdAt')
      .populate('admissionId', 'admissionNumber admissionDate dischargeDate status departmentId primaryDoctorId wardId bedId')
      .populate('createdBy', 'name firstName lastName first_name last_name')
      .sort({ createdAt: 1 }).lean(),
    PatientAdvanceLedger.find(advanceFilter).sort({ createdAt: 1 }).lean()
  ]);

  const scopedBillIds = new Set(bills.map((bill) => idString(bill._id)).filter(Boolean));
  let invoices = rawInvoices;
  if (!admissionId && appointmentId) {
    invoices = rawInvoices
      .filter((invoice) => {
        if (idString(invoice.appointment_id) === idString(appointmentId)) return true;
        const linkedIds = Array.from(new Set(
          [invoice.bill_id, ...(invoice.bill_ids || [])].map(idString).filter(Boolean)
        ));
        return linkedIds.some((billId) => scopedBillIds.has(billId));
      })
      .map((invoice) => {
        // Invoice stores both bill_id (primary) and bill_ids (aggregate list).
        // For a one-bill invoice those fields legitimately contain the same id;
        // deduplicate before deciding whether the document spans other encounters.
        const linkedIds = Array.from(new Set(
          [invoice.bill_id, ...(invoice.bill_ids || [])].map(idString).filter(Boolean)
        ));
        const matchingBills = bills.filter((bill) => linkedIds.includes(idString(bill._id)));
        const mixedEncounterInvoice = linkedIds.some((billId) => !scopedBillIds.has(billId));
        if (!mixedEncounterInvoice || !matchingBills.length) return invoice;
        const scopeTotal = matchingBills.reduce((sum, bill) => sum + asNumber(bill.total_amount), 0);
        const scopePaid = matchingBills.reduce((sum, bill) => sum + asNumber(bill.paid_amount), 0);
        const scopeSettlementDiscount = matchingBills.reduce((sum, bill) => sum + asNumber(bill.settlement_discount_amount), 0);
        const scopeCreditNotes = matchingBills.reduce((sum, bill) => sum + asNumber(bill.credit_note_amount), 0);
        return {
          ...invoice,
          _mixedEncounterInvoice: true,
          _documentTotal: asNumber(invoice.total),
          _documentPaid: asNumber(invoice.amount_paid),
          _documentBalanceDue: invoiceOutstanding(invoice),
          total: scopeTotal,
          amount_paid: scopePaid,
          settlement_discount_amount: scopeSettlementDiscount,
          credit_note_total: scopeCreditNotes,
          balance_due: Math.max(0, scopeTotal - scopePaid - scopeSettlementDiscount - scopeCreditNotes)
        };
      });
  }

  const pendingDiscountInvoiceIds = new Set();
  bills
    .filter((bill) => bill.status === 'Discount Pending Approval' || bill.discount_approval?.status === 'PENDING')
    .forEach((bill) => {
      [bill.invoice_id, ...(bill.invoice_ids || [])]
        .map(idString)
        .filter(Boolean)
        .forEach((invoiceId) => pendingDiscountInvoiceIds.add(invoiceId));
    });
  invoices = invoices.map((invoice) => ({
    ...invoice,
    _discountApprovalPending: pendingDiscountInvoiceIds.has(idString(invoice._id)) || Boolean(invoice.print_snapshot?.discountApprovalPending)
  }));

  const scopedInvoiceIds = new Set(invoices.map((invoice) => idString(invoice._id)).filter(Boolean));
  let transactions = rawTransactions;
  if (!admissionId && appointmentId) {
    transactions = rawTransactions.filter((transaction) => {
      const transactionBillId = idString(transaction.billId);
      const transactionInvoiceId = idString(transaction.invoiceId);
      if (transactionBillId && scopedBillIds.has(transactionBillId)) return true;
      if (transactionInvoiceId && scopedInvoiceIds.has(transactionInvoiceId)) {
        const invoice = invoices.find((row) => idString(row._id) === transactionInvoiceId);
        return !invoice?._mixedEncounterInvoice;
      }
      return (transaction.documentAllocations || []).some((allocation) => {
        const documentId = idString(allocation.documentId);
        return (allocation.documentType === 'Bill' && scopedBillIds.has(documentId))
          || (allocation.documentType === 'Invoice' && scopedInvoiceIds.has(documentId));
      });
    });
  }

  // OPD does not use IPDCharge rows. Convert bill line items into the same
  // charge-shaped structure so the patient detail screen can group every OPD
  // registration/consultation/service by date without a separate UI path.
  const displayCharges = admissionId
    ? charges
    : bills.flatMap((bill) => (bill.items || []).map((item, index) => {
        const canonical = normalizeFinancialLine(item);
        const rawTaxable = Number(item.taxable_amount ?? item.taxableAmount);
        const taxableAmount = Number.isFinite(rawTaxable) && (Math.abs(rawTaxable) > 0.000001 || canonical.grossAmount === 0)
          ? rawTaxable
          : Math.max(0, canonical.grossAmount - canonical.discountAmount);
        return {
          _id: item._id || `${bill._id}:${index}`,
          patientId,
          appointmentId: bill.appointment_id || (appointmentId || null),
          billId: bill._id,
          invoiceId: bill.invoice_id,
          chargeType: item.item_type || 'Miscellaneous',
          description: item.description || 'OPD billing item',
          quantity: canonical.quantity,
          rate: canonical.unitRate,
          grossAmount: canonical.grossAmount,
          discountType: item.discount_type || 'fixed',
          discountRate: Number(item.discount_rate || 0),
          discountAmount: canonical.discountAmount,
          discountReason: item.discount_reason || bill.discount_reason || '',
          taxableAmount,
          taxMode: item.tax_mode || 'exclusive',
          taxName: item.tax_name || '',
          taxCode: item.tax_code || '',
          taxRate: Number(item.tax_rate || 0),
          taxAmount: canonical.taxAmount,
          amount: canonical.netAmount,
          netAmount: canonical.netAmount,
          discount: canonical.discountAmount,
          tax: canonical.taxAmount,
          chargeDate: bill.generated_at || bill.createdAt,
          createdAt: bill.createdAt,
          status: bill.invoice_id ? 'INVOICED' : (bill.document_stage || 'GENERATED'),
          isBilled: Boolean(bill.invoice_id || (bill.invoice_ids || []).length)
        };
      }));

  const unbilledCharges = displayCharges.filter((charge) => !charge.isBilled && charge.status !== 'INVOICED');
  const activeInvoices = invoices.filter((invoice) =>
    invoice.document_stage !== 'VOID' &&
    invoice.document_stage !== 'CREDIT_NOTE' &&
    invoice.invoice_type !== 'Credit Note' &&
    invoice.status !== 'Cancelled'
  );
  const invoiceTotal = activeInvoices.reduce((sum, invoice) => sum + asNumber(invoice.total), 0);
  const billTotal = bills
    .filter((bill) => !['VOID', 'Cancelled'].includes(bill.document_stage || bill.status))
    .reduce((sum, bill) => sum + asNumber(bill.total_amount), 0);
  const chargeTotal = displayCharges.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);
  const unbilledTotal = unbilledCharges.reduce((sum, charge) => sum + asNumber(charge.netAmount ?? charge.amount), 0);

  const activeInvoiceIds = new Set(activeInvoices.map((invoice) => idString(invoice._id)).filter(Boolean));
  const invoiceLinkedBillIds = new Set(activeInvoices.flatMap((invoice) => [invoice.bill_id, ...(invoice.bill_ids || [])]).map(idString).filter(Boolean));
  const standaloneBills = bills.filter((bill) => {
    const linkedInvoiceId = idString(bill.invoice_id);
    return !invoiceLinkedBillIds.has(idString(bill._id)) && (!linkedInvoiceId || !activeInvoiceIds.has(linkedInvoiceId));
  });
  const opdOutstanding = activeInvoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0) +
    standaloneBills.reduce((sum, bill) => sum + billOutstanding(bill), 0);
  const opdPaid = activeInvoices.reduce((sum, invoice) => sum + asNumber(invoice.amount_paid), 0) +
    standaloneBills.reduce((sum, bill) => sum + asNumber(bill.paid_amount), 0);
  const orphanInvoiceTotal = activeInvoices
    .filter((invoice) => {
      const linkedIds = [invoice.bill_id, ...(invoice.bill_ids || [])].map(idString).filter(Boolean);
      return !linkedIds.length || !linkedIds.some((billId) => bills.some((bill) => idString(bill._id) === billId));
    })
    .reduce((sum, invoice) => sum + asNumber(invoice.total), 0);

  const calculatedOutstanding = admissionId
    ? activeInvoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0) + unbilledTotal
    : opdOutstanding;
  // Documents and active ledger rows are authoritative. Cached admission totals are
  // projections and may lag after settlement/credit/refund operations, so they must
  // never override the values used by billing UI and generated documents.
  const outstanding = calculatedOutstanding;
  const totalBill = admissionId
    ? asNumber(chargeTotal || invoiceTotal + unbilledTotal)
    : appointmentId
      ? billTotal
      : asNumber(billTotal + orphanInvoiceTotal);
  const paidAmount = admissionId
    ? activeInvoices.reduce((sum, invoice) => sum + asNumber(invoice.amount_paid), 0)
    : opdPaid;

  const billEntries = bills
    .filter((bill) => !['VOID', 'Cancelled'].includes(bill.document_stage || bill.status))
    .map((bill) => ({
      date: bill.generated_at || bill.createdAt,
      kind: 'BILL',
      number: bill.bill_number || String(bill._id).slice(-8).toUpperCase(),
      description: (bill.items || []).map((item) => item.description).filter(Boolean).join(', ') || 'Patient bill',
      debit: asNumber(bill.total_amount),
      credit: 0,
      billId: bill._id
    }));
  const orphanInvoiceEntries = invoices
    .filter((invoice) => {
      if (invoice.document_stage === 'VOID' || invoice.document_stage === 'CREDIT_NOTE' || invoice.invoice_type === 'Credit Note' || invoice.status === 'Cancelled') return false;
      const ids = [invoice.bill_id, ...(invoice.bill_ids || [])].map(idString).filter(Boolean);
      return !ids.length || !ids.some((billId) => bills.some((bill) => idString(bill._id) === billId));
    })
    .map((invoice) => ({
      date: invoice.issue_date || invoice.created_at || invoice.createdAt,
      kind: 'INVOICE',
      number: invoice.invoice_number,
      description: `${invoice.invoice_type || 'Patient'} invoice`,
      debit: asNumber(invoice.total),
      credit: 0,
      invoiceId: invoice._id
    }));

  const transactionEffect = (transaction) => {
    const transactionType = String(transaction.transactionType || '').toUpperCase();
    const value = asNumber(transaction.amount);

    // This running balance represents BILL LIABILITY, while patient advance is a
    // separate wallet. Receiving an advance therefore does not reduce a bill until
    // that credit is explicitly utilised. Likewise, refunding unused advance changes
    // the wallet but not the bill liability. This keeps Outstanding and Available
    // Advance independent and prevents the same money from being silently counted
    // twice.
    if (['ADVANCE_DEPOSIT', 'ADVANCE_REFUND'].includes(transactionType)) {
      return { debit: 0, credit: 0 };
    }
    if (transactionType === 'ADVANCE_UTILISATION') {
      return { debit: 0, credit: value };
    }
    if (['RECEIPT', 'SETTLEMENT', 'CREDIT_NOTE'].includes(transactionType)) {
      return { debit: 0, credit: value };
    }
    if (transactionType === 'REFUND') {
      return { debit: value, credit: 0 };
    }
    return transaction.direction === 'DEBIT'
      ? { debit: value, credit: 0 }
      : { debit: 0, credit: value };
  };

  const groupedTransactions = new Map();
  transactions.forEach((transaction) => {
    const effect = transactionEffect(transaction);
    const groupKey = [
      transaction.transactionNumber || idString(transaction._id),
      transaction.transactionType || '',
      transaction.direction || '',
      transaction.paymentMethod || ''
    ].join('|');
    if (!groupedTransactions.has(groupKey)) {
      groupedTransactions.set(groupKey, {
        date: transaction.createdAt,
        kind: transaction.transactionType,
        number: transaction.transactionNumber,
        description: transaction.remarks || transaction.transactionType,
        debit: 0,
        credit: 0,
        billId: transaction.billId,
        invoiceId: transaction.invoiceId,
        transactionIds: []
      });
    }
    const row = groupedTransactions.get(groupKey);
    row.debit = asNumber(row.debit + effect.debit);
    row.credit = asNumber(row.credit + effect.credit);
    row.transactionIds.push(transaction._id);
  });
  const transactionEntries = Array.from(groupedTransactions.values());

  const transactionReferences = new Set();
  transactions.forEach((transaction) => {
    [transaction.transactionNumber, transaction.paymentReference].filter(Boolean).forEach((reference) => transactionReferences.add(String(reference)));
  });
  const legacyPaymentEntries = [];
  const legacySeen = new Set();
  bills.forEach((bill) => (bill.payments || []).forEach((payment, index) => {
    const reference = payment.reference ? String(payment.reference) : '';
    if (reference && transactionReferences.has(reference)) return;
    const key = [reference, Number(payment.amount || 0).toFixed(2), payment.method || '', idString(bill._id)].join('|');
    if (legacySeen.has(key)) return;
    legacySeen.add(key);
    legacyPaymentEntries.push({
      date: payment.date || bill.paid_at || bill.updatedAt,
      kind: 'PAYMENT',
      number: reference || `${bill.bill_number || 'BILL'}-P${index + 1}`,
      description: `${payment.method || bill.payment_method || 'Payment'} payment`,
      debit: 0,
      credit: asNumber(payment.amount),
      billId: bill._id
    });
  }));

  // Older records can have an advance-wallet entry without a matching
  // FinancialTransaction. Keep those wallet events visible in the unified history,
  // but do not let a deposit/refund alter the bill-liability running balance. Actual
  // utilisation is represented by its invoice/payment transaction (or by the
  // invoice's amount_paid projection for legacy data).
  // FinancialTransaction may carry the patient-advance reference either as the
  // canonical transaction number or as paymentReference (the current fixture and
  // production advance-deposit path use the latter). Treat both as the same event
  // so the unified ledger never shows the same advance twice.
  const financialEventReferences = new Set();
  transactions.forEach((transaction) => {
    [transaction.transactionNumber, transaction.paymentReference]
      .filter(Boolean)
      .forEach((reference) => financialEventReferences.add(String(reference)));
  });
  const legacyAdvanceEntries = advanceLedger
    .filter((entry) => !entry.referenceNumber || !financialEventReferences.has(String(entry.referenceNumber)))
    .map((entry) => ({
      date: entry.createdAt,
      kind: `ADVANCE_${entry.transactionType}`,
      number: entry.referenceNumber || '—',
      description: entry.notes || entry.transactionType,
      debit: 0,
      credit: 0,
      walletAmount: asNumber(entry.amount),
      advanceDirection: entry.direction,
      advanceBalance: asNumber(entry.balanceAfter),
      advanceEntryId: entry._id
    }));

  let runningBalance = 0;
  const ledgerEntries = [...billEntries, ...orphanInvoiceEntries, ...transactionEntries, ...legacyPaymentEntries, ...legacyAdvanceEntries]
    .sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0))
    .map((entry) => {
      runningBalance = asNumber(runningBalance + asNumber(entry.debit) - asNumber(entry.credit));
      return { ...entry, balance: runningBalance };
    });
  const advanceAvailable = advanceLedger.length ? asNumber(advanceLedger[advanceLedger.length - 1].balanceAfter) : 0;
  const advanceTotals = advanceLedger.reduce((totals, entry) => {
    const type = String(entry.transactionType || '').toUpperCase();
    const amount = asNumber(entry.amount);
    if (entry.direction === 'CREDIT' && ['ADVANCE_DEPOSIT', 'OPENING_BALANCE'].includes(type)) {
      totals.received += amount;
    }
    if (entry.direction === 'DEBIT' && ['IPD_INVOICE_DEBIT', 'OUTSTANDING_SETTLEMENT_DEBIT'].includes(type)) {
      totals.applied += amount;
    }
    if (entry.direction === 'DEBIT' && ['REFUND_PAID', 'ADVANCE_REFUND', 'PHARMACY_ADVANCE_REFUND'].includes(type)) {
      totals.refunded += amount;
    }
    return totals;
  }, { received: 0, applied: 0, refunded: 0 });
  advanceTotals.received = asNumber(advanceTotals.received);
  advanceTotals.applied = asNumber(advanceTotals.applied);
  advanceTotals.refunded = asNumber(advanceTotals.refunded);

  // Unapplied advance is patient credit, not an invoice settlement. Outstanding
  // already reflects only posted allocations/payments/refunds, so never silently
  // net an available wallet balance against it. The UI/document can show both
  // values side by side and the advance becomes settlement only when explicitly
  // applied through the finance service.
  const patientBalance = asNumber(outstanding);
  const transactionAmount = (types) => transactions
    .filter((transaction) => types.includes(String(transaction.transactionType || '').toUpperCase()))
    .reduce((sum, transaction) => sum + asNumber(transaction.amount), 0);

  // New external money and reused patient advance are deliberately different.
  // Older mixed-payment rows recorded amountReceived=amount, so when advanceApplied
  // exists infer external collection from settlement minus advance rather than
  // trusting the legacy amountReceived field.
  const externalReceiptAmount = (transaction) => {
    if (String(transaction.transactionType || '').toUpperCase() !== 'RECEIPT') return 0;
    if (transaction.externalMoneyMovement === false) return 0;
    const settled = asNumber(transaction.amount);
    const appliedAdvance = asNumber(transaction.advanceApplied);
    if (appliedAdvance > 0) return asNumber(Math.max(0, settled - appliedAdvance));
    const recorded = asNumber(transaction.amountReceived);
    return recorded > 0 ? asNumber(Math.min(recorded, settled || recorded)) : settled;
  };
  const legacyPaymentsTotal = legacyPaymentEntries.reduce((sum, row) => sum + asNumber(row.credit), 0);
  const externalPaidAmount = asNumber(
    transactions.reduce((sum, transaction) => sum + externalReceiptAmount(transaction), 0) + legacyPaymentsTotal
  );
  const paymentRefunds = asNumber(transactionAmount(['REFUND']));
  const settlementDiscounts = asNumber(transactionAmount(['SETTLEMENT']));
  const creditNotes = asNumber(transactionAmount(['CREDIT_NOTE']));
  const totalCollectedAmount = asNumber(externalPaidAmount + advanceTotals.received);
  const netCollectedAmount = asNumber(Math.max(0, totalCollectedAmount - paymentRefunds - advanceTotals.refunded));
  const ledgerTotals = {
    totalCharged: billEntries.reduce((sum, row) => sum + asNumber(row.debit), 0) + orphanInvoiceEntries.reduce((sum, row) => sum + asNumber(row.debit), 0),
    paymentsReceived: externalPaidAmount,
    externalPaidAmount,
    totalCollectedAmount,
    netCollectedAmount,
    totalSettledAmount: asNumber(paidAmount),
    settlementDiscounts,
    creditNotes,
    refunds: paymentRefunds,
    due: outstanding,
    patientBalance,
    advanceReceived: advanceTotals.received,
    advanceApplied: advanceTotals.applied,
    advanceRefunded: advanceTotals.refunded,
    advanceAvailable
  };
  // Backward-compatible alias: "paid" means external collections, while
  // totalSettledAmount includes both external payment and advance utilisation.
  ledgerTotals.paid = ledgerTotals.externalPaidAmount;

  return {
    scope: {
      encounterType: admissionId ? 'IPD' : 'OPD',
      admissionId: admissionId || null,
      appointmentId: !admissionId ? (appointmentId || null) : null,
      mode: admissionId ? 'ADMISSION' : (appointmentId ? 'APPOINTMENT' : 'OVERALL')
    },
    patient,
    hospital,
    admission,
    bills,
    invoices,
    charges: displayCharges,
    groupedCharges: groupCharges(displayCharges),
    transactions,
    advanceLedger,
    ledgerEntries,
    ledgerTotals,
    summary: {
      totalBill,
      invoiceTotal,
      billTotal,
      unbilledTotal,
      outstandingAmount: outstanding,
      // paidAmount is retained for compatibility and represents total invoice
      // settlement (external money + applied advance). New consumers should use
      // explicit fields below rather than guessing from this aggregate.
      paidAmount,
      totalSettledAmount: asNumber(paidAmount),
      externalPaidAmount,
      paymentsApplied: externalPaidAmount,
      totalCollectedAmount,
      netCollectedAmount,
      settlementDiscounts,
      creditNotes,
      refunds: paymentRefunds,
      advanceReceived: advanceTotals.received,
      advanceApplied: advanceTotals.applied,
      advanceRefunded: advanceTotals.refunded,
      advanceAvailable,
      patientBalance,
      billCount: bills.length,
      invoiceCount: activeInvoices.length,
      chargeCount: displayCharges.length
    }
  };
}


async function getPatientIPDHistory({ hospitalId, patientId }) {
  const [patient, hospital, admissions] = await Promise.all([
    Patient.findOne({ _id: patientId, hospitalId }).lean(),
    Hospital.findById(hospitalId).select('hospitalName name address city state pinCode contact phone email logo').lean(),
    IPDAdmission.find({ hospitalId, patientId })
      .populate('primaryDoctorId', 'firstName lastName first_name last_name name')
      .populate('departmentId', 'name')
      .populate('wardId', 'name wardName')
      .populate('bedId', 'bedNumber bed_number name')
      .sort({ admissionDate: -1, createdAt: -1 })
      .lean()
  ]);

  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }

  const admissionIds = admissions.map((row) => row._id);
  if (!admissionIds.length) {
    return {
      scope: { encounterType: 'IPD', mode: 'OVERALL', patientId },
      patient,
      hospital,
      admissions: [],
      bills: [],
      invoices: [],
      charges: [],
      transactions: [],
      advanceLedger: [],
      summary: {
        admissionCount: 0,
        totalChargeAmount: 0,
        paidAmount: 0,
        outstandingAmount: 0,
        unbilledTotal: 0,
        discountAmount: 0,
        refundAmount: 0,
        advanceAvailable: 0,
        invoiceCount: 0,
        chargeCount: 0
      }
    };
  }

  const [bills, invoices, charges, transactions, advanceLedger] = await Promise.all([
    Bill.find({ hospital_id: hospitalId, patient_id: patientId, admission_id: { $in: admissionIds }, is_deleted: { $ne: true } })
      .sort({ generated_at: -1, createdAt: -1 }).lean(),
    Invoice.find({ hospital_id: hospitalId, patient_id: patientId, admission_id: { $in: admissionIds }, is_deleted: { $ne: true } })
      .populate('admission_id', 'admissionNumber admissionDate dischargeDate status')
      .sort({ issue_date: -1, created_at: -1, createdAt: -1 }).lean(),
    IPDCharge.find({ hospitalId, patientId, admissionId: { $in: admissionIds }, status: { $nin: ['VOIDED', 'CANCELLED'] } })
      .sort({ chargeDate: -1, createdAt: -1 }).lean(),
    FinancialTransaction.find({ hospitalId, patientId, admissionId: { $in: admissionIds }, status: 'POSTED' })
      .populate('invoiceId', 'invoice_number invoice_type status admission_id')
      .populate('admissionId', 'admissionNumber admissionDate dischargeDate status')
      .sort({ createdAt: -1 }).lean(),
    PatientAdvanceLedger.find({ hospitalId, patientId, admissionId: { $in: admissionIds }, status: 'POSTED' })
      .sort({ createdAt: 1 }).lean()
  ]);

  const activeInvoices = invoices.filter((invoice) =>
    invoice.document_stage !== 'VOID' &&
    invoice.document_stage !== 'CREDIT_NOTE' &&
    invoice.invoice_type !== 'Credit Note' &&
    invoice.status !== 'Cancelled'
  );
  const unbilledCharges = charges.filter((charge) => !charge.isBilled && charge.status !== 'INVOICED');
  const latestAdvanceByAdmission = new Map();
  advanceLedger.forEach((entry) => latestAdvanceByAdmission.set(idString(entry.admissionId), entry));
  const advanceAvailable = Array.from(latestAdvanceByAdmission.values())
    .reduce((sum, entry) => sum + asNumber(entry.balanceAfter), 0);
  const settlementDiscounts = transactions
    .filter((row) => String(row.transactionType || '').toUpperCase() === 'SETTLEMENT')
    .reduce((sum, row) => sum + asNumber(row.amount), 0);
  const refunds = transactions
    .filter((row) => ['REFUND', 'ADVANCE_REFUND'].includes(String(row.transactionType || '').toUpperCase()))
    .reduce((sum, row) => sum + asNumber(row.amount), 0);

  const admissionSummaries = admissions.map((admission) => {
    const admissionId = idString(admission._id);
    const admissionCharges = charges.filter((row) => idString(row.admissionId) === admissionId);
    const admissionInvoices = activeInvoices.filter((row) => idString(row.admission_id) === admissionId);
    const admissionTransactions = transactions.filter((row) => idString(row.admissionId) === admissionId);
    const admissionUnbilled = admissionCharges.filter((row) => !row.isBilled && row.status !== 'INVOICED');
    const admissionDiscounts = admissionCharges.reduce((sum, row) => sum + asNumber(row.discountAmount || row.discount), 0)
      + admissionTransactions.filter((row) => String(row.transactionType || '').toUpperCase() === 'SETTLEMENT').reduce((sum, row) => sum + asNumber(row.amount), 0);
    const calculatedChargeTotal = admissionCharges.reduce((sum, row) => sum + asNumber(row.netAmount ?? row.amount), 0);
    const calculatedPaid = admissionInvoices.reduce((sum, row) => sum + asNumber(row.amount_paid), 0);
    const calculatedOutstanding = admissionInvoices.reduce((sum, row) => sum + invoiceOutstanding(row), 0)
      + admissionUnbilled.reduce((sum, row) => sum + asNumber(row.patientLiability ?? row.netAmount ?? row.amount), 0);
    return {
      admissionId,
      admissionNumber: admission.admissionNumber,
      status: admission.status,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      department: admission.departmentId,
      doctor: admission.primaryDoctorId,
      ward: admission.wardId,
      bed: admission.bedId,
      // Admission-level running totals are canonical and avoid double-counting
      // interim/final invoices that may represent the same operational charges.
      totalChargeAmount: admission.totalBillAmount !== undefined ? asNumber(admission.totalBillAmount) : calculatedChargeTotal,
      paidAmount: admission.paidAmount !== undefined ? asNumber(admission.paidAmount) : calculatedPaid,
      outstandingAmount: admission.dueAmount !== undefined ? asNumber(admission.dueAmount) : calculatedOutstanding,
      unbilledTotal: admissionUnbilled.reduce((sum, row) => sum + asNumber(row.patientLiability ?? row.netAmount ?? row.amount), 0),
      discountAmount: admissionDiscounts,
      refundAmount: admissionTransactions.filter((row) => ['REFUND', 'ADVANCE_REFUND'].includes(String(row.transactionType || '').toUpperCase())).reduce((sum, row) => sum + asNumber(row.amount), 0),
      advanceAvailable: asNumber(latestAdvanceByAdmission.get(admissionId)?.balanceAfter),
      invoiceCount: admissionInvoices.length,
      chargeCount: admissionCharges.length
    };
  });

  return {
    scope: { encounterType: 'IPD', mode: 'OVERALL', patientId },
    patient,
    hospital,
    admissions,
    admissionSummaries,
    bills,
    invoices,
    charges,
    transactions,
    advanceLedger,
    summary: {
      admissionCount: admissions.length,
      totalChargeAmount: admissionSummaries.reduce((sum, row) => sum + asNumber(row.totalChargeAmount), 0),
      paidAmount: admissionSummaries.reduce((sum, row) => sum + asNumber(row.paidAmount), 0),
      outstandingAmount: admissionSummaries.reduce((sum, row) => sum + asNumber(row.outstandingAmount), 0),
      unbilledTotal: admissionSummaries.reduce((sum, row) => sum + asNumber(row.unbilledTotal), 0),
      discountAmount: charges.reduce((sum, row) => sum + asNumber(row.discountAmount || row.discount), 0) + settlementDiscounts,
      refundAmount: refunds,
      advanceAvailable,
      invoiceCount: activeInvoices.length,
      chargeCount: charges.length
    }
  };
}

module.exports = {
  listPatientBillingSummaries,
  listBillingTransactions,
  getPatientBillingDetails,
  getPatientIPDHistory,
  groupCharges,
  chargeSection
};
