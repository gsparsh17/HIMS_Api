'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Hospital = require('../models/Hospital');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const IPDCharge = require('../models/IPDCharge');
const IPDAdmission = require('../models/IPDAdmission');
const Appointment = require('../models/Appointment');
const Sale = require('../models/Sale');
const Patient = require('../models/Patient');

const DEFAULT_HOSPITAL_ID = '69a697c0df37f940dd7906ce';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { apply: false, forceUnresolved: false, hospitalId: DEFAULT_HOSPITAL_ID };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--force-unresolved') args.forceUnresolved = true;
    else if (arg.startsWith('--hospital-id=')) args.hospitalId = arg.split('=')[1];
  }
  if (!mongoose.isValidObjectId(args.hospitalId)) {
    throw new Error(`Invalid --hospital-id: ${args.hospitalId}`);
  }
  args.hospitalObjectId = new mongoose.Types.ObjectId(args.hospitalId);
  return args;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
}

function idString(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.$oid === 'string') return value.$oid;
    if (value._id !== undefined && value._id !== value) return idString(value._id);
    if (typeof value.toHexString === 'function') return value.toHexString();
  }
  const text = String(value);
  return mongoose.isValidObjectId(text) ? text : null;
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function uniqueIds(values) {
  return [...new Set(values.map(idString).filter(Boolean))];
}

function tenantMissing(field) {
  return { $or: [{ [field]: { $exists: false } }, { [field]: null }] };
}

// Includes missing/null values plus malformed legacy values such as
// { $oid: '...' } or a plain ObjectId string. Only BSON ObjectId is accepted.
function tenantNeedsRepair(field) {
  return { $nor: [{ [field]: { $type: 'objectId' } }] };
}

const SALE_IDEMPOTENCY_INDEX_NAME = 'hospitalId_1_idempotencyKey_1';
const SALE_IDEMPOTENCY_INDEX_KEY = { hospitalId: 1, idempotencyKey: 1 };
const SALE_IDEMPOTENCY_PARTIAL_FILTER = {
  hospitalId: { $type: 'objectId' },
  idempotencyKey: { $type: 'string' }
};

function isSaleIdempotencyKey(index) {
  return Number(index?.key?.hospitalId) === 1 && Number(index?.key?.idempotencyKey) === 1
    && Object.keys(index.key || {}).length === 2;
}

function isDesiredSaleIdempotencyIndex(index) {
  return Boolean(
    isSaleIdempotencyKey(index)
    && index.unique === true
    && index.partialFilterExpression?.hospitalId?.$type === 'objectId'
    && index.partialFilterExpression?.idempotencyKey?.$type === 'string'
  );
}

async function findSaleIdempotencyDuplicates() {
  return Sale.aggregate([
    {
      $match: {
        hospitalId: { $type: 'objectId' },
        idempotencyKey: { $type: 'string' }
      }
    },
    {
      $group: {
        _id: { hospitalId: '$hospitalId', idempotencyKey: '$idempotencyKey' },
        count: { $sum: 1 },
        ids: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 }
  ]);
}

async function ensureFinancialIndexes({ apply = false } = {}) {
  const indexes = await Sale.collection.indexes();
  const keyIndexes = indexes.filter(isSaleIdempotencyKey);
  const desired = keyIndexes.find(isDesiredSaleIdempotencyIndex);
  const obsolete = keyIndexes.filter((index) => !isDesiredSaleIdempotencyIndex(index));

  if (desired && obsolete.length === 0) {
    return { saleIdempotencyIndex: 'OK', changed: false, indexName: desired.name };
  }

  const duplicates = await findSaleIdempotencyDuplicates();
  if (duplicates.length) {
    const details = duplicates.map((row) => ({
      hospitalId: idString(row._id?.hospitalId),
      idempotencyKey: row._id?.idempotencyKey,
      count: row.count,
      ids: (row.ids || []).map(idString)
    }));
    throw new Error(`Cannot create Sale idempotency index; duplicate non-null keys exist: ${JSON.stringify(details)}`);
  }

  const action = obsolete.length
    ? `replace ${obsolete.map((index) => index.name).join(', ')}`
    : 'create';

  if (!apply) {
    console.log(`WOULD ${action.toUpperCase()} Sale idempotency index with a partial unique index (null/missing keys excluded)`);
    return {
      saleIdempotencyIndex: 'PREVIEW',
      changed: false,
      action,
      obsoleteIndexes: obsolete.map((index) => index.name)
    };
  }

  for (const index of obsolete) {
    await Sale.collection.dropIndex(index.name);
  }

  let indexName = desired?.name;
  if (!desired) {
    indexName = await Sale.collection.createIndex(SALE_IDEMPOTENCY_INDEX_KEY, {
      name: SALE_IDEMPOTENCY_INDEX_NAME,
      unique: true,
      partialFilterExpression: SALE_IDEMPOTENCY_PARTIAL_FILTER
    });
  }

  console.log(`READY Sale idempotency index ${indexName}; null/missing idempotencyKey values are excluded`);
  return { saleIdempotencyIndex: 'READY', changed: true, indexName };
}

class RelationResolver {
  constructor(targetHospitalId) {
    this.targetHospitalId = idString(targetHospitalId);
    this.caches = {
      admission: new Map(),
      appointment: new Map(),
      sale: new Map(),
      patient: new Map(),
      bill: new Map(),
      invoice: new Map()
    };
  }

  async cached(kind, model, id, projection) {
    const key = idString(id);
    if (!key) return null;
    if (this.caches[kind].has(key)) return this.caches[kind].get(key);
    const lookupId = mongoose.isValidObjectId(key) ? new mongoose.Types.ObjectId(key) : id;
    const doc = await model.findById(lookupId).select(projection).lean();
    this.caches[kind].set(key, doc || null);
    return doc || null;
  }

  async candidateHospitals(document, type) {
    const candidates = [];
    if (type === 'bill') candidates.push(document.hospital_id);
    if (type === 'invoice') candidates.push(document.hospital_id);
    if (type === 'charge' || type === 'sale') candidates.push(document.hospitalId);

    const admissionId = document.admission_id || document.admissionId;
    const appointmentId = document.appointment_id;
    const saleId = document.sale_id;
    const patientId = document.patient_id || document.patientId;
    const billId = document.bill_id || document.billId;
    const invoiceId = document.invoice_id || document.invoiceId;

    const [admission, appointment, sale, patient, bill, invoice] = await Promise.all([
      this.cached('admission', IPDAdmission, admissionId, 'hospitalId patientId'),
      this.cached('appointment', Appointment, appointmentId, 'hospital_id patient_id'),
      this.cached('sale', Sale, saleId, 'hospitalId patient_id admission_id invoice_id bill_id'),
      this.cached('patient', Patient, patientId, 'hospitalId'),
      this.cached('bill', Bill, billId, 'hospital_id patient_id admission_id appointment_id sale_id invoice_id'),
      this.cached('invoice', Invoice, invoiceId, 'hospital_id patient_id admission_id appointment_id sale_id bill_id')
    ]);

    candidates.push(
      admission?.hospitalId,
      appointment?.hospital_id,
      sale?.hospitalId,
      patient?.hospitalId,
      bill?.hospital_id,
      invoice?.hospital_id
    );

    return uniqueIds(candidates);
  }

  async resolve(document, type, { forceUnresolved = false } = {}) {
    const candidates = await this.candidateHospitals(document, type);
    if (candidates.length > 1) {
      return { status: 'conflict', candidates };
    }
    if (candidates.length === 1) {
      return candidates[0] === this.targetHospitalId
        ? { status: 'resolved', hospitalId: candidates[0], source: 'relations' }
        : { status: 'other-hospital', hospitalId: candidates[0] };
    }
    if (forceUnresolved) {
      return { status: 'resolved', hospitalId: this.targetHospitalId, source: 'forced' };
    }
    return { status: 'unresolved', candidates: [] };
  }
}

async function assertHospital(hospitalId) {
  const hospital = await Hospital.findById(hospitalId).select('hospitalName hospitalID registryNo').lean();
  if (!hospital) throw new Error(`Hospital not found: ${hospitalId}`);
  return hospital;
}

async function auditFinancialIntegrity(hospitalId) {
  const oid = typeof hospitalId === 'string' ? new mongoose.Types.ObjectId(hospitalId) : hospitalId;
  const [
    billsMissingHospital,
    invoicesMissingHospital,
    chargesMissingHospital,
    salesMissingHospital,
    billsForHospital,
    invoicesForHospital,
    chargesForHospital,
    opdBills,
    billPaidBalanceMismatch,
    invoicePaidBalanceMismatch,
    invoicedBillsStillDraft,
    billsMissingNumber,
    activeBilledCharges,
    invoiceTypes
  ] = await Promise.all([
    Bill.countDocuments(tenantNeedsRepair('hospital_id')),
    Invoice.countDocuments(tenantNeedsRepair('hospital_id')),
    IPDCharge.countDocuments(tenantNeedsRepair('hospitalId')),
    Sale.countDocuments(tenantNeedsRepair('hospitalId')),
    Bill.countDocuments({ hospital_id: oid, is_deleted: { $ne: true } }),
    Invoice.countDocuments({ hospital_id: oid, is_deleted: { $ne: true } }),
    IPDCharge.countDocuments({ hospitalId: oid }),
    Bill.countDocuments({ hospital_id: oid, admission_id: { $exists: false }, is_pharmacy_bill: { $ne: true }, is_deleted: { $ne: true } }),
    Bill.countDocuments({ hospital_id: oid, status: 'Paid', balance_due: { $gt: 0.009 }, is_deleted: { $ne: true } }),
    Invoice.countDocuments({ hospital_id: oid, status: 'Paid', balance_due: { $gt: 0.009 }, is_deleted: { $ne: true } }),
    Bill.countDocuments({ hospital_id: oid, $or: [{ invoice_id: { $ne: null } }, { 'invoice_ids.0': { $exists: true } }], document_stage: { $ne: 'INVOICED' }, is_deleted: { $ne: true } }),
    Bill.countDocuments({ hospital_id: oid, $or: [{ bill_number: { $exists: false } }, { bill_number: null }, { bill_number: '' }], is_deleted: { $ne: true } }),
    IPDCharge.countDocuments({ hospitalId: oid, isBilled: true, status: { $ne: 'INVOICED' } }),
    Invoice.aggregate([
      { $match: { hospital_id: oid, is_deleted: { $ne: true } } },
      { $group: { _id: '$invoice_type', count: { $sum: 1 }, total: { $sum: '$total' } } },
      { $sort: { count: -1, _id: 1 } }
    ])
  ]);

  return {
    hospitalId: idString(oid),
    missingTenantFields: {
      bills: billsMissingHospital,
      invoices: invoicesMissingHospital,
      ipdCharges: chargesMissingHospital,
      sales: salesMissingHospital
    },
    scopedRecords: {
      bills: billsForHospital,
      invoices: invoicesForHospital,
      ipdCharges: chargesForHospital,
      opdBills
    },
    inconsistencies: {
      paidBillsWithPositiveBalance: billPaidBalanceMismatch,
      paidInvoicesWithPositiveBalance: invoicePaidBalanceMismatch,
      invoicedBillsNotInInvoicedStage: invoicedBillsStillDraft,
      billsMissingNumber,
      billedChargesNotInvoiced: activeBilledCharges
    },
    invoiceTypes
  };
}

module.exports = {
  DEFAULT_HOSPITAL_ID,
  Bill,
  Invoice,
  IPDCharge,
  IPDAdmission,
  Appointment,
  Sale,
  Patient,
  RelationResolver,
  parseArgs,
  connect,
  assertHospital,
  auditFinancialIntegrity,
  idString,
  money,
  tenantMissing,
  tenantNeedsRepair,
  ensureFinancialIndexes,
  uniqueIds,
  mongoose
};
