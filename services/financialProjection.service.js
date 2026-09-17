const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const IPDCharge = require('../models/IPDCharge');
const mongoose = require('mongoose');
const {
  canonicalInvoiceLines,
  lineGross,
  lineNet,
  lineServiceSource,
  expectedInvoiceBalance,
  transactionAppliedAmount,
  transactionExternalAmount
} = require('./financeInvariant.service');

const { NON_REVENUE_INVOICE_TYPES } = require('./financeDocumentPolicy');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

const INVOICE_PROJECTION_FIELDS = [
  'issue_date', 'invoice_number', 'invoice_type', 'is_pharmacy_sale', 'patient_type',
  'admission_id', 'patient_id', 'patient', 'patient_snapshot', 'patient_name',
  'doctor_snapshot', 'doctor', 'doctor_id', 'doctor_name', 'consultant', 'consultant_id', 'consultant_name',
  'doctor_commission_snapshot', 'doctor_commission', 'commission', 'commission_percentage',
  'department_snapshot', 'department', 'department_id', 'department_name',
  'gross_amount', 'subtotal', 'total', 'line_discount_total', 'bill_discount_total',
  'discount', 'discount_amount', 'settlement_discount_amount', 'credit_note_total',
  'tax', 'tax_amount', 'amount_paid', 'paid_amount', 'balance_due', 'status', 'payment_history',
  'service_items', 'procedure_items', 'lab_test_items', 'radiology_items', 'medicine_items', 'items',
  'collection_owner', 'collection_mode', 'collection_transferred_to_ipd'
].join(' ');

const TRANSACTION_PROJECTION_FIELDS = [
  'postedAt', 'createdAt', 'date', 'transactionDate', 'transactionNumber', 'referenceNumber',
  'transactionType', 'direction', 'paymentMethod', 'amount', 'amountTendered', 'amountReceived', 'amount_received', 'amountApplied',
  'amount_applied', 'appliedAmount', 'externalAmount', 'advanceApplied', 'advance_applied', 'changeReturned', 'advanceCreated', 'externalMoneyMovement',
  'cashFlowClass', 'patientId', 'patient_id', 'invoiceId', 'invoice_id', 'billId', 'bill_id',
  'admissionId', 'sourceModule', 'documentAllocations', 'notes', 'description', 'remarks', 'status'
].join(' ');

const UNBILLED_PROJECTION_FIELDS = [
  'chargeDate', 'chargeType', 'netAmount', 'totalAmount', 'amount', 'financialPolicySnapshot',
  'pricingSnapshot', 'invoiceId', 'status', 'admissionId', 'patientId'
].join(' ');

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

function castId(value) {
  if (!value) return value;
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
}

function idCandidates(value) {
  if (!value) return [];
  const result = [String(value)];
  if (mongoose.Types.ObjectId.isValid(value)) result.unshift(new mongoose.Types.ObjectId(value));
  return result;
}

function combineMatch(base, conditions = []) {
  const active = conditions.filter(Boolean);
  return active.length ? { $and: [base, ...active] } : base;
}

const INVOICE_LINE_ARRAYS = ['service_items', 'procedure_items', 'lab_test_items', 'radiology_items', 'medicine_items'];
const LINE_SOURCE_FIELDS = ['service_type', 'serviceType', 'charge_type', 'chargeType', 'charge_head', 'chargeHead', 'item_type', 'itemType'];

function encounterMongoCondition(source) {
  const requested = String(source || '').trim();
  if (!requested || requested === 'all') return null;
  const pharmacy = { $or: [{ is_pharmacy_sale: true }, { invoice_type: /pharmacy/i }] };
  const notPharmacy = { $and: [{ is_pharmacy_sale: { $ne: true } }, { invoice_type: { $not: /pharmacy/i } }] };
  if (requested === 'Pharmacy') return pharmacy;
  if (requested === 'IPD') return { $and: [notPharmacy, { $or: [{ admission_id: { $exists: true, $ne: null } }, { patient_type: 'IPD' }] }] };
  if (requested === 'Emergency') return { $and: [notPharmacy, { $or: [{ admission_id: null }, { admission_id: { $exists: false } }] }, { patient_type: 'Emergency' }] };
  if (requested === 'OPD') return { $and: [notPharmacy, { $or: [{ admission_id: null }, { admission_id: { $exists: false } }] }, { patient_type: { $nin: ['IPD', 'Emergency'] } }] };
  return null;
}

function serviceRegex(source) {
  const map = {
    Lab: /lab|patholog/i,
    Radiology: /radiolog|imaging|x-?ray|ct|mri|ultrasound/i,
    Procedure: /procedure|surgery|\bot\b|operation/i,
    Pharmacy: /pharmacy|medicine|drug/i,
    Appointment: /consult|appointment|doctor/i,
    Bed: /bed|room|ward/i,
    Nursing: /nurs/i,
    Admission: /admission|registration/i
  };
  return map[source] || null;
}

function noCanonicalLinesCondition() {
  return {
    $and: INVOICE_LINE_ARRAYS.map((field) => ({
      $or: [{ [field]: { $exists: false } }, { [field]: { $size: 0 } }]
    }))
  };
}

function serviceMongoCondition(source) {
  const requested = String(source || '').trim();
  if (!requested || requested === 'all') return null;
  const regex = serviceRegex(requested);
  const lineCondition = regex
    ? {
        $or: INVOICE_LINE_ARRAYS.map((arrayField) => ({
          [arrayField]: { $elemMatch: { $or: LINE_SOURCE_FIELDS.map((field) => ({ [field]: regex })) } }
        }))
      }
    : null;

  let fallback = null;
  if (requested === 'Pharmacy') fallback = { $or: [{ is_pharmacy_sale: true }, { invoice_type: /pharmacy/i }] };
  else if (requested === 'IPD' || requested === 'OPD' || requested === 'Emergency') fallback = encounterMongoCondition(requested);
  else if (requested === 'Lab') fallback = { invoice_type: /lab|patholog/i };
  else if (requested === 'Radiology') fallback = { invoice_type: /radiolog|imaging|x-?ray|ct|mri|ultrasound/i };
  else if (requested === 'Procedure') fallback = { invoice_type: /procedure|surgery|\bot\b|operation/i };
  else if (requested === 'Appointment') fallback = { invoice_type: /appointment|consult/i };
  else if (requested === 'Bed') fallback = { invoice_type: /bed|room/i };

  const options = [];
  if (lineCondition) options.push(lineCondition);
  if (fallback) options.push({ $and: [noCanonicalLinesCondition(), fallback] });
  return options.length === 1 ? options[0] : options.length ? { $or: options } : null;
}

function invoiceMongoFilter({ range, hospitalId, query = {} }) {
  const base = {
    ...hospitalFilter(hospitalId ? castId(hospitalId) : hospitalId, 'hospital_id'),
    issue_date: { $gte: range.from, $lte: range.to },
    invoice_type: { $nin: NON_REVENUE_INVOICE_TYPES },
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Draft'] },
    document_stage: { $ne: 'VOID' },
    $nor: [
      { invoice_type: 'Pharmacy', collection_owner: 'IPD' },
      { invoice_type: 'Pharmacy', collection_mode: 'IPD_CONSOLIDATED' },
      { invoice_type: 'Pharmacy', collection_transferred_to_ipd: true }
    ]
  };
  const conditions = [];
  const encounter = query.encounterSource && query.encounterSource !== 'all' ? query.encounterSource : query.patientType;
  conditions.push(encounterMongoCondition(encounter));
  conditions.push(serviceMongoCondition(query.serviceSource));

  if (query.invoiceType && query.invoiceType !== 'all') conditions.push({ invoice_type: query.invoiceType });
  if (query.status && query.status !== 'all') {
    const statuses = String(query.status).split(',').map((value) => value.trim()).filter(Boolean);
    if (statuses.length) conditions.push({ status: { $in: statuses } });
  }
  if (query.paymentMethod && query.paymentMethod !== 'all') {
    conditions.push({ payment_history: { $elemMatch: { $or: [{ method: String(query.paymentMethod) }, { payment_method: String(query.paymentMethod) }] } } });
  }
  if (query.doctorId && query.doctorId !== 'all') {
    const ids = idCandidates(query.doctorId);
    conditions.push({
      $or: [
        { 'doctor_snapshot._id': { $in: ids } }, { 'doctor_snapshot.id': { $in: ids } },
        { doctor: { $in: ids } }, { 'doctor._id': { $in: ids } }, { 'doctor.id': { $in: ids } }, { doctor_id: { $in: ids } },
        { consultant: { $in: ids } }, { 'consultant._id': { $in: ids } }, { 'consultant.id': { $in: ids } }, { consultant_id: { $in: ids } }
      ]
    });
  }
  if (query.departmentId && query.departmentId !== 'all') {
    const ids = idCandidates(query.departmentId);
    conditions.push({
      $or: [
        { 'department_snapshot._id': { $in: ids } }, { 'department_snapshot.id': { $in: ids } },
        { department: { $in: ids } }, { 'department._id': { $in: ids } }, { 'department.id': { $in: ids } }, { department_id: { $in: ids } }
      ]
    });
  }
  if (query.minAmount !== undefined && query.minAmount !== '') conditions.push({ total: { $gte: Number(query.minAmount) } });
  if (query.maxAmount !== undefined && query.maxAmount !== '') conditions.push({ total: { $lte: Number(query.maxAmount) } });
  return combineMatch(base, conditions);
}

function transactionEncounterMongoCondition(source) {
  const requested = String(source || '').trim().toUpperCase();
  if (!requested || requested === 'ALL') return null;
  const ipd = { $or: [{ admissionId: { $exists: true, $ne: null } }, { sourceModule: { $in: [/^IPD$/i, /^Discharge$/i] } }] };
  if (requested === 'IPD') return ipd;
  if (requested === 'PHARMACY') return { sourceModule: /^Pharmacy$/i };
  if (requested === 'EMERGENCY') return { sourceModule: /^Emergency$/i };
  if (requested === 'OPD') return { $and: [{ sourceModule: { $nin: [/^Pharmacy$/i, /^IPD$/i, /^Discharge$/i] } }, { $or: [{ admissionId: null }, { admissionId: { $exists: false } }] }] };
  return null;
}

async function transactionMongoFilter({ range, hospitalId, query = {}, invoiceFilter }) {
  const base = {
    ...hospitalFilter(hospitalId ? castId(hospitalId) : hospitalId, 'hospitalId'),
    $or: [
      { postedAt: { $gte: range.from, $lte: range.to } },
      { postedAt: { $exists: false }, createdAt: { $gte: range.from, $lte: range.to } }
    ],
    status: 'POSTED'
  };
  const conditions = [transactionEncounterMongoCondition(query.encounterSource)];
  if (query.paymentMethod && query.paymentMethod !== 'all') conditions.push({ paymentMethod: query.paymentMethod });
  if (query.transactionType && query.transactionType !== 'all') conditions.push({ transactionType: query.transactionType });

  const invoiceDimensionFilterActive = [
    query.doctorId, query.departmentId, query.serviceSource, query.invoiceType,
    query.status, query.minAmount, query.maxAmount
  ].some((value) => value !== undefined && value !== null && value !== '' && value !== 'all');
  if (invoiceDimensionFilterActive) {
    const invoiceIds = await Invoice.distinct('_id', invoiceFilter);
    if (!invoiceIds.length) return combineMatch(base, [{ _id: { $exists: false } }]);
    conditions.push({ $or: [{ invoiceId: { $in: invoiceIds } }, { invoice_id: { $in: invoiceIds } }] });
  }
  return combineMatch(base, conditions);
}

function unbilledMongoFilter({ range, hospitalId, query = {} }) {
  const base = {
    ...hospitalFilter(hospitalId ? castId(hospitalId) : hospitalId, 'hospitalId'),
    chargeDate: { $gte: range.from, $lte: range.to },
    status: { $in: ['ACTIVE', 'UNBILLED'] },
    $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }]
  };
  if (query.encounterSource && query.encounterSource !== 'all' && String(query.encounterSource).toUpperCase() !== 'IPD') {
    return combineMatch(base, [{ _id: { $exists: false } }]);
  }
  const conditions = [];
  if (query.serviceSource && query.serviceSource !== 'all') {
    const regex = serviceRegex(query.serviceSource);
    if (regex) conditions.push({ chargeType: regex });
    else if (query.serviceSource === 'IPD') {
      // All unbilled IPDCharge rows belong to IPD by definition.
    } else conditions.push({ _id: { $exists: false } });
  }
  if (query.departmentId && query.departmentId !== 'all') {
    conditions.push({ 'financialPolicySnapshot.context.departmentId': { $in: idCandidates(query.departmentId) } });
  }
  if (query.doctorId && query.doctorId !== 'all') {
    conditions.push({ 'pricingSnapshot.inputs.doctorId': { $in: idCandidates(query.doctorId) } });
  }
  const amountExpression = { $ifNull: ['$netAmount', { $ifNull: ['$amount', 0] }] };
  if (query.minAmount !== undefined && query.minAmount !== '') conditions.push({ $expr: { $gte: [amountExpression, Number(query.minAmount)] } });
  if (query.maxAmount !== undefined && query.maxAmount !== '') conditions.push({ $expr: { $lte: [amountExpression, Number(query.maxAmount)] } });
  return combineMatch(base, conditions);
}

function invoiceSummaryGroupStage() {
  const lineDiscount = { $ifNull: ['$line_discount_total', 0] };
  const billDiscount = { $ifNull: ['$bill_discount_total', 0] };
  const legacyDiscount = { $ifNull: ['$discount', { $ifNull: ['$discount_amount', 0] }] };
  const settlementDiscount = { $ifNull: ['$settlement_discount_amount', 0] };
  const creditNotes = { $ifNull: ['$credit_note_total', 0] };
  const baseDiscount = {
    $cond: [
      { $or: [{ $ne: [lineDiscount, 0] }, { $ne: [billDiscount, 0] }] },
      { $add: [lineDiscount, billDiscount] },
      legacyDiscount
    ]
  };
  const netRevenueRaw = { $subtract: [{ $ifNull: ['$total', 0] }, { $add: [settlementDiscount, creditNotes] }] };
  const netRevenue = { $cond: [{ $gt: [netRevenueRaw, 0] }, netRevenueRaw, 0] };
  return {
    $group: {
      _id: null,
      grossBilled: { $sum: { $ifNull: ['$gross_amount', { $ifNull: ['$subtotal', '$total'] }] } },
      discounts: { $sum: { $add: [baseDiscount, settlementDiscount] } },
      tax: { $sum: { $ifNull: ['$tax', { $ifNull: ['$tax_amount', 0] }] } },
      creditNotes: { $sum: creditNotes },
      netRevenue: { $sum: netRevenue },
      outstanding: { $sum: { $ifNull: ['$balance_due', 0] } },
      invoiceCount: { $sum: 1 }
    }
  };
}

function transactionAmountStages() {
  return [
    {
      $addFields: {
        __txType: { $toUpper: { $ifNull: ['$transactionType', ''] } },
        __direction: { $toUpper: { $ifNull: ['$direction', ''] } },
        __cashFlowClass: { $toUpper: { $ifNull: ['$cashFlowClass', ''] } },
        __explicitReceived: { $ifNull: ['$amountReceived', { $ifNull: ['$amount_received', 0] }] },
        __explicitApplied: { $ifNull: ['$amountApplied', { $ifNull: ['$amount_applied', 0] }] },
        __advanceApplied: { $ifNull: ['$advanceApplied', { $ifNull: ['$advance_applied', 0] }] }
      }
    },
    {
      $addFields: {
        __appliedAmount: {
          $cond: [
            { $gt: ['$__explicitApplied', 0] }, '$__explicitApplied',
            { $cond: [{ $in: ['$__txType', ['RECEIPT', 'ADVANCE_UTILISATION']] }, { $ifNull: ['$amount', 0] }, '$__explicitApplied'] }
          ]
        },
        __externalAmount: {
          $cond: [
            {
              $or: [
                { $eq: ['$externalMoneyMovement', false] },
                { $in: ['$__cashFlowClass', ['WALLET_UTILISATION', 'NON_CASH_ADJUSTMENT']] },
                { $in: ['$__txType', ['REFUND', 'ADVANCE_REFUND', 'ADVANCE_UTILISATION']] }
              ]
            },
            0,
            {
              $cond: [
                { $gt: ['$__explicitReceived', 0] }, '$__explicitReceived',
                {
                  $switch: {
                    branches: [
                      { case: { $eq: ['$__txType', 'RECEIPT'] }, then: { $let: { vars: { receiptExternal: { $subtract: [{ $ifNull: ['$amount', 0] }, '$__advanceApplied'] } }, in: { $cond: [{ $gt: ['$$receiptExternal', 0] }, '$$receiptExternal', 0] } } } },
                      { case: { $eq: ['$__txType', 'ADVANCE_DEPOSIT'] }, then: { $ifNull: ['$amount', 0] } }
                    ],
                    default: { $ifNull: ['$amount', 0] }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  ];
}

async function canonicalSummary({ query = {}, user = {}, range, hospitalId, invoiceFilter }) {
  const txFilter = await transactionMongoFilter({ range, hospitalId, query, invoiceFilter });
  const chargeFilter = unbilledMongoFilter({ range, hospitalId, query });
  const [invoiceAgg, transactionAgg, unbilledAgg] = await Promise.all([
    Invoice.aggregate([{ $match: invoiceFilter }, invoiceSummaryGroupStage()]),
    FinancialTransaction.aggregate([
      { $match: txFilter },
      ...transactionAmountStages(),
      {
        $group: {
          _id: null,
          collections: { $sum: { $cond: [{ $and: [{ $eq: ['$__direction', 'CREDIT'] }, { $eq: ['$__txType', 'RECEIPT'] }] }, '$__externalAmount', 0] } },
          advancesReceived: { $sum: { $cond: [{ $and: [{ $eq: ['$__direction', 'CREDIT'] }, { $eq: ['$__txType', 'ADVANCE_DEPOSIT'] }] }, '$__externalAmount', 0] } },
          advanceUtilised: { $sum: { $cond: [{ $eq: ['$__txType', 'ADVANCE_UTILISATION'] }, '$__appliedAmount', 0] } },
          refunds: { $sum: { $cond: [{ $and: [{ $eq: ['$__direction', 'DEBIT'] }, { $in: ['$__txType', ['REFUND', 'ADVANCE_REFUND']] }] }, { $ifNull: ['$amount', 0] }, 0] } },
          receiptCount: { $sum: { $cond: [{ $and: [{ $eq: ['$__direction', 'CREDIT'] }, { $eq: ['$__txType', 'RECEIPT'] }] }, 1, 0] } }
        }
      }
    ]),
    IPDCharge.aggregate([
      { $match: chargeFilter },
      { $group: { _id: null, unbilledProduction: { $sum: { $ifNull: ['$netAmount', { $ifNull: ['$totalAmount', { $ifNull: ['$amount', 0] }] }] } } } }
    ])
  ]);
  const invoice = invoiceAgg[0] || {};
  const tx = transactionAgg[0] || {};
  const unbilled = unbilledAgg[0] || {};
  const collections = money(tx.collections || 0);
  const advancesReceived = money(tx.advancesReceived || 0);
  const refunds = money(tx.refunds || 0);
  const invoiceCount = Number(invoice.invoiceCount || 0);
  const netRevenue = money(invoice.netRevenue || 0);
  return {
    grossBilled: money(invoice.grossBilled || 0),
    discounts: money(invoice.discounts || 0),
    tax: money(invoice.tax || 0),
    creditNotes: money(invoice.creditNotes || 0),
    netRevenue,
    collections,
    advancesReceived,
    advanceUtilised: money(tx.advanceUtilised || 0),
    refunds,
    netCashCollection: money(collections + advancesReceived - refunds),
    outstanding: money(invoice.outstanding || 0),
    unbilledProduction: money(unbilled.unbilledProduction || 0),
    invoiceCount,
    receiptCount: Number(tx.receiptCount || 0),
    averageInvoiceValue: invoiceCount ? money(netRevenue / invoiceCount) : 0
  };
}

async function paginatedInvoiceReport({ query = {}, user = {} }) {
  const range = parseHospitalRange(query);
  const hospitalId = query.hospitalId || user.hospital_id || user.hospitalId;
  const filter = invoiceMongoFilter({ range, hospitalId, query });
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(query.limit || 25)));
  const skip = (page - 1) * limit;
  const [facet, summary] = await Promise.all([
    Invoice.aggregate([
      { $match: filter },
      { $sort: { issue_date: -1, _id: -1 } },
      { $facet: { rows: [{ $skip: skip }, { $limit: limit }], meta: [{ $count: 'total' }] } }
    ]),
    canonicalSummary({ query, user, range, hospitalId, invoiceFilter: filter })
  ]);
  const bucket = facet[0] || { rows: [], meta: [] };
  const rows = (bucket.rows || []).map(invoiceRow);
  const total = Number(bucket.meta?.[0]?.total || 0);
  return { range, summary, reportKey: 'invoices', rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

async function paginatedTransactionReport({ query = {}, user = {} }) {
  const range = parseHospitalRange(query);
  const hospitalId = query.hospitalId || user.hospital_id || user.hospitalId;
  const invoiceFilter = invoiceMongoFilter({ range, hospitalId, query });
  const filter = await transactionMongoFilter({ range, hospitalId, query, invoiceFilter });
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(query.limit || 25)));
  const skip = (page - 1) * limit;
  const [facet, summary] = await Promise.all([
    FinancialTransaction.aggregate([
      { $match: filter },
      { $addFields: { __reportDate: { $ifNull: ['$postedAt', { $ifNull: ['$createdAt', { $ifNull: ['$date', '$transactionDate'] }] }] } } },
      { $sort: { __reportDate: -1, _id: -1 } },
      { $facet: { rows: [{ $skip: skip }, { $limit: limit }, { $project: { __reportDate: 0 } }], meta: [{ $count: 'total' }] } }
    ]),
    canonicalSummary({ query, user, range, hospitalId, invoiceFilter })
  ]);
  const bucket = facet[0] || { rows: [], meta: [] };
  const rows = (bucket.rows || []).map(transactionRow);
  const total = Number(bucket.meta?.[0]?.total || 0);
  return { range, summary, reportKey: 'transactions', rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

function invoiceEncounterSource(invoice) {
  if (invoice.is_pharmacy_sale || /pharmacy/i.test(invoice.invoice_type || '')) return 'Pharmacy';
  if (invoice.admission_id || invoice.patient_type === 'IPD') return 'IPD';
  if (invoice.patient_type === 'Emergency') return 'Emergency';
  return 'OPD';
}

function invoiceServiceSources(invoice) {
  const lineSources = Array.from(new Set(canonicalInvoiceLines(invoice).map(lineServiceSource).filter(Boolean)));
  if (lineSources.length) return lineSources;
  const type = String(invoice.invoice_type || invoice.type || '').toLowerCase();
  if (type.includes('lab')) return ['Lab'];
  if (type.includes('radiology') || type.includes('imaging') || type.includes('x-ray')) return ['Radiology'];
  if (type.includes('procedure') || type.includes('surgery') || type.includes('ot')) return ['Procedure'];
  if (type.includes('appointment') || type.includes('consult')) return ['Appointment'];
  if (type.includes('bed') || type.includes('room')) return ['Bed'];
  if (type.includes('pharmacy')) return ['Pharmacy'];
  return [invoiceEncounterSource(invoice)];
}

function invoiceServiceSource(invoice) {
  const sources = invoiceServiceSources(invoice);
  return sources.length === 1 ? sources[0] : 'Mixed';
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
    if (query.serviceSource && query.serviceSource !== 'all' && !invoiceServiceSources(invoice).includes(query.serviceSource)) return false;
    if (query.invoiceType && query.invoiceType !== 'all' && invoice.invoice_type !== query.invoiceType) return false;
    if (query.status && query.status !== 'all') {
      const statuses = String(query.status).split(',').map((value) => value.trim()).filter(Boolean);
      if (statuses.length && !statuses.includes(String(invoice.status || ''))) return false;
    }
    if (query.paymentMethod && query.paymentMethod !== 'all') {
      const methods = Array.isArray(invoice.payment_history)
        ? invoice.payment_history.map((entry) => String(entry?.method || entry?.payment_method || ''))
        : [];
      if (!methods.includes(String(query.paymentMethod))) return false;
    }
    if (query.doctorId && query.doctorId !== 'all' && doctor.id !== String(query.doctorId)) return false;
    if (query.departmentId && query.departmentId !== 'all' && department.id !== String(query.departmentId)) return false;
    if (query.minAmount && total < Number(query.minAmount)) return false;
    if (query.maxAmount && total > Number(query.maxAmount)) return false;
    return true;
  });
}

function applyTransactionFilters(transactions, query = {}, filteredInvoiceIds = new Set()) {
  const invoiceDimensionFilterActive = [
    query.doctorId,
    query.departmentId,
    query.serviceSource,
    query.invoiceType,
    query.status,
    query.minAmount,
    query.maxAmount
  ].some((value) => value !== undefined && value !== null && value !== '' && value !== 'all');

  return transactions.filter((tx) => {
    if (query.paymentMethod && query.paymentMethod !== 'all' && tx.paymentMethod !== query.paymentMethod) return false;
    if (query.transactionType && query.transactionType !== 'all' && tx.transactionType !== query.transactionType) return false;

    if (query.encounterSource && query.encounterSource !== 'all') {
      const requested = String(query.encounterSource).toUpperCase();
      const sourceModule = String(tx.sourceModule || '').toUpperCase();
      const isIpd = Boolean(tx.admissionId) || ['IPD', 'DISCHARGE'].includes(sourceModule);
      const isPharmacy = sourceModule === 'PHARMACY';
      if (requested === 'IPD' && !isIpd) return false;
      if (requested === 'PHARMACY' && !isPharmacy) return false;
      if (requested === 'OPD' && (isIpd || isPharmacy)) return false;
      if (requested === 'EMERGENCY' && sourceModule !== 'EMERGENCY') return false;
    }

    // Doctor/department/service/status/amount filters belong to invoices.
    // Transactions without an invoice cannot be attributed to those dimensions
    // without inventing accounting ownership, so omit them from filtered totals.
    if (invoiceDimensionFilterActive) {
      const invoiceId = textId(tx.invoiceId || tx.invoice_id);
      if (!invoiceId || !filteredInvoiceIds.has(invoiceId)) return false;
    }

    return true;
  });
}

function chargeServiceSource(charge = {}) {
  const type = String(charge.chargeType || '').toLowerCase();
  if (type.includes('lab')) return 'Lab';
  if (type.includes('radiology') || type.includes('imaging')) return 'Radiology';
  if (type.includes('procedure') || type.includes('surgery') || type.includes('ot')) return 'Procedure';
  if (type.includes('bed') || type.includes('room')) return 'Bed';
  if (type.includes('pharmacy')) return 'Pharmacy';
  if (type.includes('doctor') || type.includes('consult')) return 'Appointment';
  return charge.chargeType || 'Other';
}

function applyUnbilledFilters(charges, query = {}) {
  if (query.encounterSource && query.encounterSource !== 'all' && String(query.encounterSource).toUpperCase() !== 'IPD') return [];
  return (charges || []).filter((charge) => {
    if (query.serviceSource && query.serviceSource !== 'all' && chargeServiceSource(charge) !== query.serviceSource) return false;
    const departmentId = textId(charge.financialPolicySnapshot?.context?.departmentId || charge.financialPolicySnapshot?.context?.department_id);
    if (query.departmentId && query.departmentId !== 'all' && departmentId !== String(query.departmentId)) return false;
    const doctorId = textId(charge.pricingSnapshot?.inputs?.doctorId || charge.pricingSnapshot?.inputs?.doctor_id);
    if (query.doctorId && query.doctorId !== 'all' && doctorId !== String(query.doctorId)) return false;
    const amount = Number(charge.netAmount ?? charge.amount ?? 0);
    if (query.minAmount && amount < Number(query.minAmount)) return false;
    if (query.maxAmount && amount > Number(query.maxAmount)) return false;
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
      invoice_type: { $nin: NON_REVENUE_INVOICE_TYPES },
      is_deleted: { $ne: true },
      status: { $nin: ['Cancelled', 'Draft'] },
      document_stage: { $ne: 'VOID' },
      $nor: [
        { invoice_type: 'Pharmacy', collection_owner: 'IPD' },
        { invoice_type: 'Pharmacy', collection_mode: 'IPD_CONSOLIDATED' },
        { invoice_type: 'Pharmacy', collection_transferred_to_ipd: true }
      ]
    }).select(INVOICE_PROJECTION_FIELDS).lean(),
    FinancialTransaction.find({
      ...hospitalFilter(hospitalId, 'hospitalId'),
      $or: [
        { postedAt: { $gte: range.from, $lte: range.to } },
        { postedAt: { $exists: false }, createdAt: { $gte: range.from, $lte: range.to } }
      ],
      status: 'POSTED'
    }).select(TRANSACTION_PROJECTION_FIELDS).lean(),
    IPDCharge.find({
      ...hospitalFilter(hospitalId, 'hospitalId'),
      chargeDate: { $gte: range.from, $lte: range.to },
      status: { $in: ['ACTIVE', 'UNBILLED'] },
      $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }]
    }).select(UNBILLED_PROJECTION_FIELDS).lean()
  ]);
  const invoices = applyInvoiceFilters(rawInvoices, query);
  const filteredInvoiceIds = new Set(invoices.map((invoice) => textId(invoice._id)));
  return {
    range,
    hospitalId,
    invoices,
    transactions: applyTransactionFilters(rawTransactions, query, filteredInvoiceIds),
    unbilledCharges: applyUnbilledFilters(unbilledCharges, query)
  };
}

function invoiceRow(invoice) {
  const doctor = doctorMeta(invoice);
  const department = departmentMeta(invoice);
  const gross = money(invoice.gross_amount ?? invoice.subtotal ?? invoice.total);
  const lineDiscount = money(invoice.line_discount_total || 0);
  const billDiscount = money(invoice.bill_discount_total || 0);
  const legacyDiscount = money(invoice.discount ?? invoice.discount_amount ?? 0);
  const baseDiscount = lineDiscount || billDiscount ? money(lineDiscount + billDiscount) : legacyDiscount;
  const settlementDiscount = money(invoice.settlement_discount_amount || 0);
  const creditNotes = money(invoice.credit_note_total || 0);
  const recognisedAdjustments = money(settlementDiscount + creditNotes);
  const netRevenue = money(Math.max(0, Number(invoice.total || 0) - recognisedAdjustments));
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
    discount: money(baseDiscount + settlementDiscount),
    baseDiscount,
    settlementDiscount,
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
  const txDate = tx.postedAt || tx.createdAt || tx.date || tx.transactionDate;
  const type = String(tx.transactionType || '').toUpperCase();
  const externalAmount = transactionExternalAmount(tx);
  const appliedAmount = transactionAppliedAmount(tx);
  return {
    id: tx._id,
    date: txDate,
    postedAt: txDate,
    transactionNumber: tx.transactionNumber || tx.referenceNumber || '',
    transactionType: tx.transactionType,
    direction: tx.direction,
    paymentMethod: tx.paymentMethod || 'Unspecified',
    amount: money(tx.amount),
    externalAmount,
    appliedAmount,
    refundAmount: type === 'REFUND' || type === 'ADVANCE_REFUND' ? money(tx.amount) : 0,
    amountTendered: money(tx.amountTendered ?? externalAmount),
    amountApplied: appliedAmount,
    changeReturned: money(tx.changeReturned || 0),
    advanceCreated: money(tx.advanceCreated || 0),
    externalMoneyMovement: tx.externalMoneyMovement !== false,
    cashFlowClass: tx.cashFlowClass || '',
    patientId: textId(tx.patientId || tx.patient_id),
    invoiceId: textId(tx.invoiceId || tx.invoice_id),
    billId: textId(tx.billId || tx.bill_id),
    documentAllocations: tx.documentAllocations || [],
    notes: tx.notes || tx.description || tx.remarks || ''
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
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch (_) {
    try {
      return d.toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }
}

function monthKey(date, timezone = 'Asia/Kolkata') {
  const day = dayKey(date, timezone);
  return day ? day.slice(0, 7) : '';
}

function serviceRowsForInvoice(invoice) {
  const parent = invoiceRow(invoice);
  const lines = canonicalInvoiceLines(invoice);
  if (!lines.length) return [{ ...parent, service: parent.serviceSource, invoiceId: parent.id, lineGross: parent.gross, lineNet: parent.netRevenue }];
  const totalLineNet = money(lines.reduce((sum, line) => sum + lineNet(line), 0));
  return lines.map((line, index) => {
    const net = lineNet(line);
    const gross = lineGross(line);
    const weight = totalLineNet > 0 ? net / totalLineNet : 1 / lines.length;
    return {
      invoiceId: parent.id,
      lineId: textId(line._id || line.charge_id || line.chargeId) || `${textId(parent.id)}:${index}`,
      service: lineServiceSource(line),
      grossBilled: gross,
      netRevenue: money(Math.max(0, net - ((parent.settlementDiscount + parent.creditNotes) * weight))),
      outstanding: money(parent.outstanding * weight),
      doctorCommission: money(parent.doctorCommission * weight),
      hospitalShare: money(Math.max(0, net - ((parent.settlementDiscount + parent.creditNotes) * weight)) - (parent.doctorCommission * weight))
    };
  });
}

function groupServiceRows(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.service || 'Other';
    if (!groups.has(key)) groups.set(key, { service: key, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0, doctorCommission: 0, hospitalShare: 0, _invoiceIds: new Set() });
    const target = groups.get(key);
    target.grossBilled = money(target.grossBilled + Number(row.grossBilled || 0));
    target.netRevenue = money(target.netRevenue + Number(row.netRevenue || 0));
    target.outstanding = money(target.outstanding + Number(row.outstanding || 0));
    target.doctorCommission = money(target.doctorCommission + Number(row.doctorCommission || 0));
    target.hospitalShare = money(target.hospitalShare + Number(row.hospitalShare || 0));
    target._invoiceIds.add(String(row.invoiceId || ''));
  });
  return [...groups.values()].map((row) => ({ ...row, invoiceCount: row._invoiceIds.size, _invoiceIds: undefined })).sort((a, b) => b.netRevenue - a.netRevenue);
}

function project(data) {
  const invoiceRows = data.invoices.map(invoiceRow);
  const serviceRows = data.invoices.flatMap(serviceRowsForInvoice);
  const allTransactions = data.transactions.map(transactionRow);
  const externalCredits = allTransactions.filter((tx) => tx.direction === 'CREDIT' && tx.externalAmount > 0);
  const refunds = allTransactions.filter((tx) => ['REFUND', 'ADVANCE_REFUND'].includes(String(tx.transactionType || '').toUpperCase()) && tx.direction === 'DEBIT');
  const receipts = externalCredits.filter((tx) => String(tx.transactionType || '').toUpperCase() === 'RECEIPT');
  const advances = externalCredits.filter((tx) => String(tx.transactionType || '').toUpperCase() === 'ADVANCE_DEPOSIT');
  const advanceUsed = allTransactions.filter((tx) => String(tx.transactionType || '').toUpperCase() === 'ADVANCE_UTILISATION');

  const summary = {
    grossBilled: sumRows(invoiceRows, 'gross'),
    discounts: sumRows(invoiceRows, 'discount'),
    tax: sumRows(invoiceRows, 'tax'),
    creditNotes: sumRows(invoiceRows, 'creditNotes'),
    netRevenue: sumRows(invoiceRows, 'netRevenue'),
    collections: sumRows(receipts, 'externalAmount'),
    advancesReceived: sumRows(advances, 'externalAmount'),
    advanceUtilised: sumRows(advanceUsed, 'appliedAmount'),
    refunds: sumRows(refunds, 'refundAmount'),
    netCashCollection: money(sumRows(receipts, 'externalAmount') + sumRows(advances, 'externalAmount') - sumRows(refunds, 'refundAmount')),
    outstanding: sumRows(invoiceRows, 'outstanding'),
    unbilledProduction: money((data.unbilledCharges || []).reduce((s, row) => s + Number(row.netAmount ?? row.totalAmount ?? row.amount ?? 0), 0)),
    invoiceCount: invoiceRows.length,
    receiptCount: receipts.length,
    averageInvoiceValue: invoiceRows.length ? money(sumRows(invoiceRows, 'netRevenue') / invoiceRows.length) : 0
  };

  const bySource = group(invoiceRows, (r) => r.encounterSource, (source) => ({ source, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  });
  const byService = groupServiceRows(serviceRows);
  const byDoctor = group(invoiceRows, (r) => r.doctorId || r.doctorName, (key) => ({ doctorId: '', doctorName: key, netRevenue: 0, doctorCommission: 0, hospitalShare: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.doctorId ||= r.doctorId; a.doctorName = r.doctorName; a.netRevenue = money(a.netRevenue + r.netRevenue); a.doctorCommission = money(a.doctorCommission + r.doctorCommission); a.hospitalShare = money(a.hospitalShare + r.hospitalShare); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  }).sort((a, b) => b.netRevenue - a.netRevenue);
  const byDepartment = group(invoiceRows, (r) => r.departmentId || r.departmentName, (key) => ({ departmentId: '', departmentName: key, netRevenue: 0, doctorCommission: 0, hospitalShare: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => {
    a.departmentId ||= r.departmentId; a.departmentName = r.departmentName; a.netRevenue = money(a.netRevenue + r.netRevenue); a.doctorCommission = money(a.doctorCommission + r.doctorCommission); a.hospitalShare = money(a.hospitalShare + r.hospitalShare); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1;
  }).sort((a, b) => b.netRevenue - a.netRevenue);
  const paymentMethods = group(externalCredits, (r) => r.paymentMethod, (paymentMethod) => ({ paymentMethod, amount: 0, count: 0 }), (a, r) => { a.amount = money(a.amount + r.externalAmount); a.count += 1; }).sort((a, b) => b.amount - a.amount);
  const daily = group(invoiceRows, (r) => dayKey(r.date, data.range?.timezone) || 'Unknown', (date) => ({ date, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0, collections: 0 }), (a, r) => { a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1; }).sort((a, b) => a.date.localeCompare(b.date));
  const dailyMap = new Map(daily.map((row) => [row.date, row]));
  receipts.forEach((row) => {
    const txDate = row.date || row.postedAt;
    const date = dayKey(txDate, data.range?.timezone) || 'Unknown';
    if (!dailyMap.has(date)) {
      const item = { date, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0, collections: 0 };
      dailyMap.set(date, item);
      daily.push(item);
    }
    dailyMap.get(date).collections = money(dailyMap.get(date).collections + row.externalAmount);
  });
  daily.sort((a, b) => a.date.localeCompare(b.date));
  const monthly = group(invoiceRows, (r) => monthKey(r.date, data.range?.timezone) || 'Unknown', (month) => ({ month, grossBilled: 0, netRevenue: 0, outstanding: 0, invoiceCount: 0 }), (a, r) => { a.grossBilled = money(a.grossBilled + r.gross); a.netRevenue = money(a.netRevenue + r.netRevenue); a.outstanding = money(a.outstanding + r.outstanding); a.invoiceCount += 1; }).sort((a, b) => a.month.localeCompare(b.month));

  return { range: data.range, summary, bySource, byService, byDoctor, byDepartment, paymentMethods, daily, monthly, invoiceRows, serviceRows, transactionRows: allTransactions };
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
  if (reportKey === 'invoices') return paginatedInvoiceReport({ query, user });
  if (reportKey === 'transactions') return paginatedTransactionReport({ query, user });

  const data = await load({ query, user });
  const projection = project(data);
  // Report tabs only need their own rows plus the shared summary/range.
  // Returning every projection (daily/service/doctor/transaction arrays) on every
  // tab made the Income page payload grow unnecessarily with reporting volume.
  const common = { range: projection.range, summary: projection.summary, reportKey };
  if (reportKey === 'revenue') return { ...common, rows: projection.invoiceRows };
  if (reportKey === 'collections') return { ...common, rows: projection.transactionRows.filter((r) => r.externalMoneyMovement || ['REFUND', 'ADVANCE_REFUND', 'ADVANCE_UTILISATION'].includes(r.transactionType)) };
  if (reportKey === 'unbilled') return { ...common, rows: data.unbilledCharges };
  if (reportKey === 'daily') return { ...common, rows: projection.daily };
  if (reportKey === 'monthly') return { ...common, rows: projection.monthly };
  if (reportKey === 'doctor') return { ...common, rows: projection.byDoctor };
  if (reportKey === 'department') return { ...common, rows: projection.byDepartment };
  if (reportKey === 'service') return { ...common, rows: projection.byService };
  if (reportKey === 'ipd') return { ...common, rows: projection.invoiceRows.filter((r) => r.encounterSource === 'IPD'), unbilledRows: data.unbilledCharges };
  if (reportKey === 'reconciliation') {
    const anomalies = [];
    data.invoices.forEach((invoice) => {
      const expected = expectedInvoiceBalance(invoice);
      if (Math.abs(expected - money(invoice.balance_due || 0)) > 0.02) anomalies.push({ type: 'INVOICE_BALANCE_MISMATCH', invoiceId: invoice._id, invoiceNumber: invoice.invoice_number, expected, actual: money(invoice.balance_due || 0) });
    });
    return { ...common, rows: anomalies };
  }
  const error = new Error(`Unsupported finance report: ${reportKey}`);
  error.statusCode = 400;
  throw error;
}

module.exports = { parseHospitalRange, getKpis, getReport, project, dayKey, monthKey, invoiceRow, transactionRow, invoiceServiceSources, serviceRowsForInvoice, groupServiceRows, invoiceMongoFilter, transactionMongoFilter, unbilledMongoFilter, canonicalSummary };
