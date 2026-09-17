'use strict';

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const IPDAdmission = require('../models/IPDAdmission');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const PharmacyReturn = require('../models/PharmacyReturn');
const HospitalPharmacySetting = require('../models/HospitalPharmacySetting');
const { CLOSED_ADMISSION_STATUSES, isChargeFrozen } = require('./ipdLifecycleGuard.service');

const MONEY_EPSILON = 0.009;

const money = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100
    : 0;
};

function httpError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  if (code) error.code = code;
  return error;
}

function objectId(value, name) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) {
    throw httpError(`${name} is required and must be a valid ObjectId.`, 400, 'INVALID_RETURN_CONTEXT');
  }
  return new mongoose.Types.ObjectId(value);
}

function optionalObjectId(value, name) {
  if (!value) return null;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw httpError(`${name} must be a valid ObjectId.`, 400, 'INVALID_RETURN_CONTEXT');
  }
  return new mongoose.Types.ObjectId(value);
}

function id(value) {
  if (!value) return '';
  if (typeof value === 'object') return String(value._id || value.id || value);
  return String(value);
}

function normalizeEncounterType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized || normalized === 'AUTO') return null;
  if (['IPD', 'OPD', 'WALKIN'].includes(normalized)) return normalized;
  throw httpError('encounterType must be IPD, OPD, WALKIN or AUTO.', 400, 'INVALID_RETURN_CONTEXT');
}

function saleEncounterType(sale) {
  if (sale?.admission_id) return 'IPD';
  if (sale?.patient_id) return 'OPD';
  return 'WALKIN';
}

function lineQuantity(item) {
  return Math.max(0, Number(item?.quantity_base_units ?? item?.quantity ?? 0));
}

function lineReturnedQuantity(item) {
  return Math.max(0, Number(item?.returned_quantity_base_units ?? 0));
}

function lineFinancials(item) {
  const quantity = Math.max(1, lineQuantity(item));
  const gross = Math.max(0, money(item?.gross_amount ?? (Number(item?.rate_per_base_unit ?? item?.unit_price ?? 0) * quantity)));
  const discount = Math.max(0, money(item?.discount_amount ?? item?.discount ?? 0));
  const taxable = Math.max(0, money(item?.taxable_amount ?? (gross - discount)));
  const taxRate = Math.max(0, money(item?.tax_rate ?? item?.gst_rate ?? 0));
  const tax = Math.max(0, money(item?.tax_amount ?? (taxable * taxRate) / 100));
  const net = Math.max(0, money(item?.net_amount ?? item?.total_price ?? (taxable + tax)));
  return { quantity, gross, discount, taxable, taxRate, tax, net };
}

function returnMatchKeys(returnRecord, returnItem) {
  const saleId = id(returnRecord?.originalSaleId);
  const saleItemId = id(returnItem?.saleItemId);
  const medicineId = id(returnItem?.medicineId);
  const batchId = id(returnItem?.batchId);
  return {
    exact: saleId && saleItemId ? `${saleId}|${saleItemId}` : '',
    legacy: saleId && medicineId ? `${saleId}|${medicineId}|${batchId}` : '',
  };
}

function buildPendingAndPostedReturnMaps(returnRecords = []) {
  const bySaleItem = new Map();
  const byMedicineBatch = new Map();

  for (const record of returnRecords) {
    if (String(record?.status || '') === 'Rejected') continue;
    for (const item of record?.items || []) {
      const quantity = money(item?.returnedQtyBaseUnits ?? item?.quantity_base_units ?? item?.quantity ?? 0);
      if (quantity <= 0) continue;
      const keys = returnMatchKeys(record, item);
      if (keys.exact) bySaleItem.set(keys.exact, money((bySaleItem.get(keys.exact) || 0) + quantity));
      if (keys.legacy) byMedicineBatch.set(keys.legacy, money((byMedicineBatch.get(keys.legacy) || 0) + quantity));
    }
  }

  return { bySaleItem, byMedicineBatch };
}

function stockBalanceForSaleLine(stockRows, sale, item) {
  const medicineId = id(item?.medicine_id);
  const batchId = id(item?.batch_id);
  const saleId = id(sale?._id);

  const matching = stockRows.filter((stock) =>
    id(stock?.medicineId) === medicineId &&
    (!batchId || id(stock?.batchId) === batchId)
  );

  const linked = matching.filter((stock) =>
    Array.isArray(stock?.sourceSaleIds) && stock.sourceSaleIds.some((sourceSaleId) => id(sourceSaleId) === saleId)
  );

  const rows = linked.length ? linked : matching;
  return money(rows.reduce((sum, stock) => sum + Number(stock?.currentBalanceBaseUnits || 0), 0));
}

function buildCandidateRows({ sales = [], returnRecords = [], stockRows = [], encounterType }) {
  const maps = buildPendingAndPostedReturnMaps(returnRecords);
  const candidates = [];

  for (const sale of sales) {
    const saleId = id(sale._id);
    for (const item of sale.items || []) {
      const originalQuantity = money(lineQuantity(item));
      if (originalQuantity <= 0) continue;

      const saleItemId = id(item._id);
      const medicineId = id(item.medicine_id);
      const batchId = id(item.batch_id);
      const exactKey = `${saleId}|${saleItemId}`;
      const legacyKey = `${saleId}|${medicineId}|${batchId}`;
      const returnRecordQuantity = Math.max(
        maps.bySaleItem.get(exactKey) || 0,
        maps.byMedicineBatch.get(legacyKey) || 0
      );
      const alreadyReturned = money(Math.max(lineReturnedQuantity(item), returnRecordQuantity));
      const remainingFromSale = money(Math.max(0, originalQuantity - alreadyReturned));
      if (remainingFromSale <= MONEY_EPSILON) continue;

      const bedsideBalance = encounterType === 'IPD'
        ? stockBalanceForSaleLine(stockRows, sale, item)
        : remainingFromSale;
      const availableQuantity = money(Math.max(0, Math.min(remainingFromSale, bedsideBalance)));
      if (availableQuantity <= MONEY_EPSILON) continue;

      const financials = lineFinancials(item);
      candidates.push({
        id: `${saleId}_${saleItemId || medicineId}_${batchId}`,
        uniqueId: `${saleId}_${saleItemId || medicineId}_${batchId}`,
        saleId,
        saleItemId,
        saleNumber: sale.sale_number || sale.invoice_number || '—',
        saleDate: sale.sale_date,
        medicineId,
        batchId,
        medicineName: item.medicine_name || item.medicine_id?.name || 'Medicine',
        composition: item.composition || item.medicine_id?.composition || '',
        batchNumber: item.batch_number || item.batch_id?.batch_number || 'N/A',
        expiryDate: item.expiry_date || item.batch_id?.expiry_date || null,
        baseUnit: item.base_unit || 'unit',
        packUnit: item.pack_unit || 'pack',
        unitsPerPack: Number(item.units_per_pack || 1),
        originalQuantity,
        alreadyReturned,
        availableQuantity,
        bedsideStockBalance: encounterType === 'IPD' ? bedsideBalance : null,
        effectiveUnitPrice: money(financials.net / financials.quantity),
        unitPrice: money(item.unit_price ?? item.rate_per_base_unit ?? 0),
        taxRate: financials.taxRate,
        mrp: Number(item.mrp || item.mrp_price || 0),
        hsnCode: item.hsn_code || item.medicine_id?.hsn_code || 'NA',
      });
    }
  }

  return candidates;
}

function saleFinancialSnapshot(sale) {
  const originalTotal = money(sale.total_amount);
  const returnAmount = money(sale.return_amount);
  const inferredNet = money(Math.max(0, originalTotal - returnAmount));
  let netAfterReturns = sale.net_amount_after_returns;
  if (netAfterReturns === undefined || netAfterReturns === null || (money(netAfterReturns) === 0 && inferredNet > 0 && returnAmount === 0)) {
    netAfterReturns = inferredNet;
  }

  return {
    originalSubtotal: money(sale.subtotal ?? sale.gross_amount),
    originalDiscount: money(sale.discount_amount ?? sale.discount),
    originalTax: money(sale.tax),
    originalTotal,
    returnAmount,
    netAfterReturns: money(netAfterReturns),
    paid: money(sale.amount_paid),
    balanceDue: money(sale.balance_due),
  };
}

function groupBills(sales, candidates) {
  const bySale = new Map();
  for (const sale of sales) {
    bySale.set(id(sale._id), {
      saleId: id(sale._id),
      saleNumber: sale.sale_number || sale.invoice_number || '—',
      saleDate: sale.sale_date,
      items: [],
      financials: saleFinancialSnapshot(sale),
      sale,
    });
  }
  for (const candidate of candidates) {
    const bill = bySale.get(candidate.saleId);
    if (bill) bill.items.push(candidate);
  }
  return Array.from(bySale.values()).filter((bill) => bill.items.length > 0);
}

function eligibilityForAdmission(admission) {
  if (!admission) return { allowed: true, code: null, message: '' };
  if (CLOSED_ADMISSION_STATUSES.has(String(admission.status || '')) || admission.finalDischargedAt) {
    return {
      allowed: false,
      code: 'IPD_ADMISSION_CLOSED',
      message: 'Medicine return is blocked because this IPD admission is finally closed.',
    };
  }
  if (isChargeFrozen(admission)) {
    return {
      allowed: false,
      code: 'IPD_CHARGE_FREEZE_ACTIVE',
      message: 'Medicine return is blocked because IPD charges are frozen for final billing.',
    };
  }
  if (String(admission.pharmacyClearanceStatus || '') === 'cleared') {
    return {
      allowed: false,
      code: 'PHARMACY_CLEARANCE_COMPLETE',
      message: 'Pharmacy clearance is complete. Use the controlled credit-note/reversal process instead of an ordinary medicine return.',
    };
  }
  return { allowed: true, code: null, message: '' };
}

async function loadReturnPolicy({ hospitalId, pharmacyId }) {
  const scoped = pharmacyId
    ? await HospitalPharmacySetting.findOne({ hospitalId, pharmacyId }).lean()
    : null;
  const row = scoped || await HospitalPharmacySetting.findOne({ hospitalId }).sort({ pharmacyId: 1 }).lean();
  return {
    ipdAdvanceMode: row?.ipdAdvanceMode || 'HYBRID',
    allowCashRefundOnReturn: row?.allowCashRefundOnReturn !== false,
    requireReturnApproval: row?.requireReturnApproval === true,
  };
}

async function getReturnCandidates({ hospitalId, encounterType, patientId, admissionId, saleId, limit = 100 }) {
  const hospitalObjectId = objectId(hospitalId, 'hospitalId');
  let normalizedEncounterType = normalizeEncounterType(encounterType);
  const requestedPatientId = optionalObjectId(patientId, 'patientId');
  const requestedAdmissionId = optionalObjectId(admissionId, 'admissionId');
  const requestedSaleId = optionalObjectId(saleId, 'saleId');

  let directSale = null;
  if (requestedSaleId) {
    directSale = await Sale.findOne({ _id: requestedSaleId, hospitalId: hospitalObjectId })
      .populate('patient_id', 'salutation first_name middle_name last_name patientId uhid phone gender dob age patient_type')
      .populate('admission_id', 'admissionNumber shipNumber shipNo status patientId pharmacyClearanceStatus chargeFreeze finalDischargedAt wardId bedId roomId primaryDoctorId')
      .populate('doctor_id', 'firstName lastName name')
      .populate('items.medicine_id', 'name composition generic_name brand hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .lean();
    if (!directSale) throw httpError('Sale not found.', 404, 'SALE_NOT_FOUND');
    normalizedEncounterType = normalizedEncounterType || saleEncounterType(directSale);
  }

  if (!normalizedEncounterType) {
    normalizedEncounterType = requestedAdmissionId ? 'IPD' : requestedPatientId ? 'OPD' : null;
  }
  if (!normalizedEncounterType) {
    throw httpError('Return context is required. Choose an OPD patient, IPD admission, or a specific sale.', 400, 'RETURN_CONTEXT_REQUIRED');
  }

  let patient = null;
  let admission = null;

  if (normalizedEncounterType === 'IPD') {
    const effectiveAdmissionId = requestedAdmissionId || directSale?.admission_id?._id || directSale?.admission_id;
    admission = await IPDAdmission.findOne({ _id: objectId(effectiveAdmissionId, 'admissionId'), hospitalId: hospitalObjectId })
      .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone gender dob age patient_type')
      .populate('primaryDoctorId', 'firstName lastName name specialization')
      .populate('wardId', 'name floor type')
      .populate('bedId', 'bedNumber bedType')
      .populate('roomId', 'room_number type name')
      .lean();
    if (!admission) throw httpError('IPD admission not found.', 404, 'IPD_ADMISSION_NOT_FOUND');
    patient = admission.patientId || null;
    if (requestedPatientId && patient && id(patient._id) !== id(requestedPatientId)) {
      throw httpError('Selected patient does not belong to the selected IPD admission.', 409, 'RETURN_CONTEXT_MISMATCH');
    }
  } else if (normalizedEncounterType === 'OPD') {
    const effectivePatientId = requestedPatientId || directSale?.patient_id?._id || directSale?.patient_id;
    patient = await Patient.findOne({ _id: objectId(effectivePatientId, 'patientId'), hospitalId: hospitalObjectId, is_active: { $ne: false } })
      .select('salutation first_name middle_name last_name patientId uhid phone gender dob age patient_type sponsor_type sponsor_name')
      .lean();
    if (!patient) throw httpError('Patient not found.', 404, 'PATIENT_NOT_FOUND');
  } else if (!directSale) {
    throw httpError('Walk-in returns require a specific sale.', 400, 'WALKIN_SALE_REQUIRED');
  }

  const saleFilter = {
    hospitalId: hospitalObjectId,
    status: { $ne: 'Cancelled' },
  };

  if (requestedSaleId) {
    saleFilter._id = requestedSaleId;
  } else if (normalizedEncounterType === 'IPD') {
    saleFilter.admission_id = admission._id;
  } else if (normalizedEncounterType === 'OPD') {
    saleFilter.patient_id = patient._id;
    // Explicitly keep OPD returns separate from any active/historical IPD
    // admission on the same Patient document.
    saleFilter.admission_id = null;
  }

  let sales = await Sale.find(saleFilter)
    .populate('patient_id', 'salutation first_name middle_name last_name patientId uhid phone gender dob age patient_type')
    .populate('admission_id', 'admissionNumber shipNumber shipNo status')
    .populate('doctor_id', 'firstName lastName name')
    .populate('items.medicine_id', 'name composition generic_name brand hsn_code gst_rate')
    .populate('items.batch_id', 'batch_number expiry_date')
    .sort({ sale_date: -1, _id: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit || 100))))
    .lean();

  if (directSale && sales.length === 0) {
    // This can only happen when the caller supplied a contradictory explicit
    // context. Fail loudly rather than silently switching OPD/IPD ownership.
    throw httpError('The selected sale does not belong to the selected return context.', 409, 'RETURN_CONTEXT_MISMATCH');
  }

  if (directSale && normalizedEncounterType !== saleEncounterType(directSale)) {
    throw httpError('The selected sale does not belong to the selected encounter type.', 409, 'RETURN_CONTEXT_MISMATCH');
  }
  if (directSale && normalizedEncounterType === 'OPD' && id(directSale.patient_id) !== id(patient?._id)) {
    throw httpError('The selected sale does not belong to the selected OPD patient.', 409, 'RETURN_CONTEXT_MISMATCH');
  }
  if (directSale && normalizedEncounterType === 'IPD' && id(directSale.admission_id) !== id(admission?._id)) {
    throw httpError('The selected sale does not belong to the selected IPD admission.', 409, 'RETURN_CONTEXT_MISMATCH');
  }
  if (directSale && normalizedEncounterType === 'WALKIN' && (directSale.patient_id || directSale.admission_id)) {
    throw httpError('The selected sale is not a walk-in sale.', 409, 'RETURN_CONTEXT_MISMATCH');
  }

  const saleIds = sales.map((sale) => sale._id);
  const [returnRecords, stockRows] = await Promise.all([
    saleIds.length
      ? PharmacyReturn.find({ hospitalId: hospitalObjectId, originalSaleId: { $in: saleIds } })
        .sort({ returnedAt: -1, createdAt: -1 })
        .lean()
      : Promise.resolve([]),
    normalizedEncounterType === 'IPD'
      ? IPDPatientMedicineStock.find({
        hospitalId: hospitalObjectId,
        admissionId: admission._id,
        patientId: patient?._id,
        stockSource: 'INTERNAL_PHARMACY',
        currentBalanceBaseUnits: { $gt: 0 },
      }).lean()
      : Promise.resolve([]),
  ]);

  const candidates = buildCandidateRows({ sales, returnRecords, stockRows, encounterType: normalizedEncounterType });
  const bills = groupBills(sales, candidates);
  const pharmacyId = sales.find((sale) => sale.pharmacy_id)?.pharmacy_id || null;
  const returnPolicy = await loadReturnPolicy({ hospitalId: hospitalObjectId, pharmacyId });
  const eligibility = normalizedEncounterType === 'IPD'
    ? eligibilityForAdmission(admission)
    : { allowed: true, code: null, message: '' };

  return {
    context: {
      encounterType: normalizedEncounterType,
      patientId: patient?._id || directSale?.patient_id?._id || directSale?.patient_id || null,
      admissionId: admission?._id || null,
      saleId: requestedSaleId || null,
      patient,
      admission,
      eligibility,
      returnType: normalizedEncounterType === 'IPD'
        ? 'IPD_UNUSED_MEDICINE'
        : normalizedEncounterType === 'OPD'
          ? 'OPD_RETURN'
          : 'WALKIN_RETURN',
    },
    returnPolicy,
    sales,
    returns: returnRecords,
    candidates,
    bills,
    totals: {
      saleCount: sales.length,
      returnableBillCount: bills.length,
      returnableLineCount: candidates.length,
      previousReturnCount: returnRecords.length,
    },
  };
}

module.exports = {
  money,
  normalizeEncounterType,
  saleEncounterType,
  buildCandidateRows,
  getReturnCandidates,
};
