const mongoose = require('mongoose');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const IPDCharge = require('../models/IPDCharge');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const InventoryLedger = require('../models/InventoryLedger');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const PharmacyReturn = require('../models/PharmacyReturn');
const Prescription = require('../models/Prescription');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');

function objectIdOrUndefined(id) {
  return id && mongoose.Types.ObjectId.isValid(id) ? id : undefined;
}

function getHospitalId(req, explicitHospitalId) {
  return objectIdOrUndefined(explicitHospitalId || req.user?.hospital_id || req.user?.hospitalId || req.body?.hospitalId || req.query?.hospitalId);
}

function getCreatedBy(req) {
  return objectIdOrUndefined(req.user?._id || req.user?.id);
}

function normalizeMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function frequencyToPerDay(frequency = '') {
  const raw = String(frequency || '').trim();
  const f = raw.toUpperCase();
  const map = { OD: 1, QD: 1, BD: 2, BID: 2, TDS: 3, TID: 3, QDS: 4, QID: 4, HS: 1, NOCTE: 1, MANE: 1, SOS: 0, STAT: 1 };
  if (map[f] != null) return map[f];
  if (/^[01]-[01]-[01]$/.test(f)) return f.split('-').reduce((sum, part) => sum + Number(part), 0);
  const qMatch = f.match(/^Q(\d+)H$/);
  if (qMatch) {
    const hours = Number(qMatch[1]);
    return hours > 0 ? Math.floor(24 / hours) : 1;
  }
  const numMatch = f.match(/(\d+)\s*(TIMES|TIME|X)\s*(A|PER)?\s*DAY/);
  if (numMatch) return Number(numMatch[1]);
  return 1;
}

function parseDurationDays(duration, durationUnit) {
  if (typeof duration === 'number') {
    const unit = String(durationUnit || 'Days').toLowerCase();
    if (unit.startsWith('week')) return duration * 7;
    if (unit.startsWith('month')) return duration * 30;
    return duration;
  }
  const raw = String(duration || '').trim();
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  const value = match ? Number(match[1]) : 1;
  const lower = raw.toLowerCase();
  if (lower.includes('week')) return value * 7;
  if (lower.includes('month')) return value * 30;
  return value;
}

function parseDoseQty(dosage = '') {
  if (typeof dosage === 'number') return dosage;
  const raw = String(dosage || '').trim();
  const fractionMap = { '½': 0.5, '1/2': 0.5, '¼': 0.25, '1/4': 0.25 };
  for (const [token, val] of Object.entries(fractionMap)) {
    if (raw.includes(token)) return val;
  }
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 1;
}

function calculateRequiredBaseUnits(item = {}) {
  if (item.quantity_base_units != null) return Math.max(0, Number(item.quantity_base_units));
  if (item.quantityBaseUnits != null) return Math.max(0, Number(item.quantityBaseUnits));
  if (item.quantity != null && !item.dosage && !item.frequency && !item.duration) return Math.max(0, Number(item.quantity));
  const doseQty = Number(item.doseQty || item.dose_qty || parseDoseQty(item.dosage));
  const perDay = Number(item.frequencyPerDay || item.frequency_per_day || frequencyToPerDay(item.frequency));
  const durationDays = Number(item.durationDays || item.duration_days || parseDurationDays(item.duration, item.durationUnit || item.duration_unit));
  const calculated = doseQty * perDay * durationDays;
  if (!Number.isFinite(calculated) || calculated <= 0) return Math.max(1, Number(item.quantity || 1));
  return Math.ceil(calculated);
}

async function getAdvanceBalance({ admissionId, patientId, walletType = 'PHARMACY_IPD' }) {
  const query = { walletType };
  if (admissionId) query.admissionId = admissionId;
  else if (patientId) query.patientId = patientId;
  const last = await PatientAdvanceLedger.findOne(query).sort({ createdAt: -1 });
  if (last) return Number(last.balanceAfter || 0);
  if (walletType === 'IPD_SHARED' && admissionId) {
    const admission = await IPDAdmission.findById(admissionId).select('advanceAmount');
    return Number(admission?.advanceAmount || 0);
  }
  return 0;
}

async function createAdvanceLedgerEntry({ hospitalId, patientId, admissionId, walletType = 'PHARMACY_IPD', transactionType, direction, amount, paymentMethod, referenceNumber, sourceModule = 'Pharmacy', sourceId, notes, createdBy }) {
  const current = await getAdvanceBalance({ admissionId, patientId, walletType });
  const normalizedAmount = normalizeMoney(amount);
  const balanceAfter = normalizeMoney(direction === 'CREDIT' ? current + normalizedAmount : current - normalizedAmount);
  const entry = await PatientAdvanceLedger.create({
    hospitalId,
    patientId,
    admissionId,
    walletType,
    transactionType,
    direction,
    amount: normalizedAmount,
    paymentMethod,
    referenceNumber,
    sourceModule,
    sourceId,
    balanceAfter,
    notes,
    createdBy
  });
  if (walletType === 'IPD_SHARED' && admissionId) {
    await IPDAdmission.findByIdAndUpdate(admissionId, { advanceAmount: Math.max(balanceAfter, 0) });
  }
  return entry;
}

function paymentCashDirection(method) {
  if (['IPDAdvance', 'PharmacyAdvance', 'Insurance', 'Credit', 'Pending', 'Adjustment', 'NoPayment', 'Deferred'].includes(method)) return 'NON_CASH';
  return 'IN';
}

function normalizePayments({ total, payment_method, payments, noPayment = false }) {
  if (noPayment || payment_method === 'Pending' || payment_method === 'Credit' || payment_method === 'NoPayment' || payment_method === 'Deferred') {
    return [];
  }
  if (Array.isArray(payments) && payments.length > 0) {
    return payments
      .map(p => ({
        method: p.method || p.paymentMethod || p.payment_method || 'Cash',
        amount: normalizeMoney(p.amount),
        reference: p.reference || p.referenceNumber || p.transaction_id || '',
        walletType: p.walletType || p.wallet_type || ((p.method || p.paymentMethod) === 'PharmacyAdvance' ? 'PHARMACY_IPD' : (p.method || p.paymentMethod) === 'IPDAdvance' ? 'IPD_SHARED' : null)
      }))
      .filter(p => p.amount > 0);
  }
  return [{
    method: payment_method || 'Cash',
    amount: normalizeMoney(total),
    reference: '',
    walletType: payment_method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : payment_method === 'IPDAdvance' ? 'IPD_SHARED' : null
  }].filter(p => p.amount > 0);
}

function normalizePaymentsWithOverpayment({ total, payment_method, payments }) {
  return normalizePayments({ total, payment_method, payments });
}

async function resolvePatientContext({ patientId, admissionId, prescriptionId, explicit = {} }) {
  const [patient, admission, prescription] = await Promise.all([
    patientId ? mongoose.model('Patient').findById(patientId).lean() : null,
    admissionId ? IPDAdmission.findById(admissionId).populate('primaryDoctorId', 'firstName lastName name').lean() : null,
    prescriptionId ? Prescription.findById(prescriptionId).populate('doctor_id', 'firstName lastName name').lean() : null
  ]);

  const doctorId = objectIdOrUndefined(explicit.doctor_id || explicit.doctorId || prescription?.doctor_id?._id || admission?.primaryDoctorId?._id);
  let doctor = prescription?.doctor_id || admission?.primaryDoctorId || null;
  if (!doctor && doctorId) doctor = await Doctor.findById(doctorId).select('firstName lastName name').lean();

  const doctorName = normalizeText(explicit.doctor_name || explicit.doctorName || doctor?.name || [doctor?.firstName, doctor?.lastName].filter(Boolean).join(' '));
  const patientName = normalizeText(explicit.customer_name || explicit.customerName || [patient?.salutation, patient?.first_name, patient?.middle_name, patient?.last_name].filter(Boolean).join(' '));

  return {
    patient,
    admission,
    prescription,
    doctorId,
    doctorName,
    patientName,
    patientPhone: explicit.customer_phone || explicit.customerPhone || patient?.phone,
    uhid: explicit.uhid || patient?.uhid || patient?.patientId,
    registrationNumber: explicit.registration_number || explicit.registrationNumber || admission?.admissionNumber || patient?.patientId,
    shipNo: explicit.ship_no || explicit.shipNo || admission?.shipNo || admission?.admissionNumber,
    sponsorType: explicit.sponsor_type || explicit.sponsorType || admission?.paymentType || patient?.sponsorType || 'Self',
    sponsorName: explicit.sponsor_name || explicit.sponsorName || admission?.insuranceDetails?.provider || admission?.paymentType || 'Self',
    wardName: explicit.ward_name || explicit.wardName,
    bedName: explicit.bed_name || explicit.bedName
  };
}

// ========== HELPER: Validate Deferred Payment Return ==========
async function validateDeferredPaymentReturn(saleId) {
  const sale = await Sale.findById(saleId);
  if (!sale) throw new Error('Sale not found');

  if (sale.payment_deferred && sale.balance_due > 0) {
    return {
      isDeferred: true,
      balanceDue: sale.balance_due,
      canReturn: true,
      message: `This is a deferred payment with balance due ₹${sale.balance_due}. Return amount will reduce the outstanding balance.`
    };
  }

  return { isDeferred: false, canReturn: true };
}

// ========== HELPER: Handle Deferred Payment Return ==========
async function handleDeferredPaymentReturn(originalSale, refundAmount, refundMode, returnId, createdBy) {
  const newBalanceDue = normalizeMoney(originalSale.balance_due - refundAmount);

  originalSale.balance_due = Math.max(0, newBalanceDue);
  originalSale.return_amount = normalizeMoney((originalSale.return_amount || 0) + refundAmount);
  originalSale.net_amount_after_returns = normalizeMoney(
    Math.max(0, (originalSale.total_amount || 0) - (originalSale.return_amount || 0))
  );

  if (originalSale.balance_due <= 0) {
    originalSale.status = 'Completed';
    originalSale.payment_deferred = false;
    originalSale.settled_at = new Date();
  } else {
    originalSale.status = 'PartiallyReturned';
  }

  await originalSale.save();

  if (refundAmount > 0 && originalSale.admission_id && originalSale.patient_id &&
    ['IPDAdvance', 'PharmacyAdvance'].includes(refundMode)) {
    await createAdvanceLedgerEntry({
      hospitalId: originalSale.hospitalId,
      patientId: originalSale.patient_id,
      admissionId: originalSale.admission_id,
      walletType: refundMode === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED',
      transactionType: 'PHARMACY_RETURN_CREDIT',
      direction: 'CREDIT',
      amount: refundAmount,
      paymentMethod: refundMode,
      referenceNumber: returnId,
      sourceModule: 'Pharmacy',
      sourceId: returnId,
      notes: `Medicine return on deferred payment ${originalSale.sale_number}`,
      createdBy: createdBy || originalSale.created_by
    });
  }

  return originalSale;
}

// ========== buildSaleItems - Allocate bill discount proportionally before tax calculation ==========
async function buildSaleItems(rawItems = [], { honorLooseSale = true, defaultDoctor = {}, billDiscount = 0, billDiscountType = 'percentage' } = {}) {
  const tempItems = [];
  let totalGross = 0;

  for (const rawItem of rawItems) {
    const batchId = rawItem.batch_id || rawItem.batchId;
    if (!batchId) throw new Error(`Batch is required for ${rawItem.medicine_name || rawItem.medicineName || rawItem.medicine_id || rawItem.medicineId}`);
    const batch = await MedicineBatch.findById(batchId).populate('medicine_id');
    if (!batch) throw new Error('Selected batch not found');
    const medicine = batch.medicine_id;
    if (!medicine) throw new Error('Medicine linked to selected batch not found');

    let quantityBaseUnits = calculateRequiredBaseUnits(rawItem);
    const unitsPerPack = Number(rawItem.units_per_pack || rawItem.unitsPerPack || batch.units_per_pack || medicine.units_per_pack || 1);
    const allowLoose = honorLooseSale && medicine.allow_loose_sale !== false;
    if (!allowLoose) quantityBaseUnits = Math.ceil(quantityBaseUnits / unitsPerPack) * unitsPerPack;

    const available = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    if (available < quantityBaseUnits) {
      throw new Error(`Insufficient stock for ${medicine.name}. Available ${available} ${medicine.base_unit || 'unit'}, requested ${quantityBaseUnits}.`);
    }

    const ratePerBaseUnit = Number(rawItem.rate_per_base_unit || rawItem.unit_price || batch.selling_price_per_base_unit || (batch.selling_price || 0) / unitsPerPack || 0);
    const grossAmount = normalizeMoney(quantityBaseUnits * ratePerBaseUnit);
    totalGross += grossAmount;

    tempItems.push({
      rawItem,
      batch,
      medicine,
      quantityBaseUnits,
      unitsPerPack,
      ratePerBaseUnit,
      grossAmount,
      doctorId: objectIdOrUndefined(rawItem.doctor_id || rawItem.doctorId || rawItem.prescribed_by || rawItem.prescribedBy || defaultDoctor.doctorId),
      doctorName: normalizeText(rawItem.doctor_name || rawItem.doctorName || rawItem.prescribed_by_name || rawItem.prescribedByName || defaultDoctor.doctorName)
    });
  }

  let billDiscountAmount = 0;
  const discountPercent = Number(billDiscount || 0);
  if (billDiscountType === 'percentage') {
    billDiscountAmount = totalGross * (discountPercent / 100);
  } else {
    billDiscountAmount = Math.min(discountPercent, totalGross);
  }

  const discountRatio = totalGross > 0 ? billDiscountAmount / totalGross : 0;
  const items = [];

  for (const temp of tempItems) {
    const { rawItem, batch, medicine, quantityBaseUnits, unitsPerPack, ratePerBaseUnit, grossAmount, doctorId, doctorName } = temp;

    const itemDiscountAmount = normalizeMoney(grossAmount * discountRatio);
    const taxableAmount = normalizeMoney(Math.max(0, grossAmount - itemDiscountAmount));

    let taxRate = null;
    let taxSource = null;

    if (batch.tax_snapshot && batch.tax_snapshot.gst_rate !== undefined && batch.tax_snapshot.gst_rate !== null) {
      taxRate = Number(batch.tax_snapshot.gst_rate);
      taxSource = 'batch.tax_snapshot';
      console.log(`✅ Using batch.tax_snapshot: ${taxRate}% for batch ${batch.batch_number} (${medicine.name})`);
    } else if (medicine.gst_rate !== undefined && medicine.gst_rate !== null) {
      taxRate = Number(medicine.gst_rate);
      taxSource = 'medicine.gst_rate';
      console.log(`⚠️ Using medicine.gst_rate: ${taxRate}% for batch ${batch.batch_number} (${medicine.name}) - No tax_snapshot found`);
    } else if (rawItem.force_override_tax === true && (rawItem.tax_rate !== undefined || rawItem.taxRate !== undefined)) {
      taxRate = Number(rawItem.tax_rate ?? rawItem.taxRate);
      taxSource = 'frontend_override';
      console.log(`⚠️ MANUAL OVERRIDE: Using frontend tax_rate: ${taxRate}% for batch ${batch.batch_number} (${medicine.name})`);
      if (taxRate === 0 && batch.tax_snapshot?.gst_rate > 0) {
        console.warn(`⚠️⚠️⚠️ TAX COMPLIANCE WARNING: Overriding tax from ${batch.tax_snapshot.gst_rate}% to 0% for ${medicine.name}`);
      }
    } else {
      taxRate = 0;
      taxSource = 'default';
      console.error(`❌ No GST source found for batch ${batch.batch_number} (${medicine.name}). Defaulting to 0%.`);
    }

    const validGSTRates = [0, 5, 12, 18, 28];
    if (!validGSTRates.includes(taxRate)) {
      throw new Error(`Invalid GST rate ${taxRate}% for batch ${batch.batch_number}. Valid rates: 0, 5, 12, 18, 28`);
    }

    const taxAmount = normalizeMoney(taxableAmount * taxRate / 100);
    const cgstAmount = normalizeMoney(taxAmount / 2);
    const sgstAmount = normalizeMoney(taxAmount / 2);
    const netAmount = normalizeMoney(taxableAmount + taxAmount);

    const item = {
      medicine_id: medicine._id,
      batch_id: batch._id,
      medicine_name: rawItem.medicine_name || rawItem.medicineName || medicine.name,
      composition: rawItem.composition || medicine.composition || medicine.generic_name,
      generic_name: rawItem.generic_name || medicine.generic_name,
      brand: rawItem.brand || medicine.brand,
      hsn_code: rawItem.hsn_code || rawItem.hsnCode || medicine.hsn_code,
      batch_number: batch.batch_number,
      expiry_date: batch.expiry_date,
      quantity: quantityBaseUnits,
      quantity_base_units: quantityBaseUnits,
      base_unit: medicine.base_unit || 'unit',
      pack_unit: medicine.pack_unit || 'unit',
      units_per_pack: unitsPerPack,
      packs: Math.floor(quantityBaseUnits / unitsPerPack),
      loose_units: quantityBaseUnits % unitsPerPack,
      unit_price: ratePerBaseUnit,
      rate_per_base_unit: ratePerBaseUnit,
      rate_per_pack: normalizeMoney(ratePerBaseUnit * unitsPerPack),
      discount: Number(rawItem.discount || 0),
      tax_rate: taxRate,
      tax_source: taxSource,
      gross_amount: grossAmount,
      discount_amount: itemDiscountAmount,
      taxable_amount: taxableAmount,
      tax_amount: taxAmount,
      cgst_rate: taxRate / 2,
      sgst_rate: taxRate / 2,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      total_price: netAmount,
      net_amount: netAmount,
      purchase_rate_per_base_unit: Number(rawItem.purchase_rate_per_base_unit || rawItem.purchaseRatePerBaseUnit || batch.purchase_price_per_base_unit || 0),
      purchase_amount: normalizeMoney(quantityBaseUnits * (rawItem.purchase_rate_per_base_unit || rawItem.purchaseRatePerBaseUnit || batch.purchase_price_per_base_unit || 0)),
      gross_profit: normalizeMoney(taxableAmount - (quantityBaseUnits * (rawItem.purchase_rate_per_base_unit || rawItem.purchaseRatePerBaseUnit || batch.purchase_price_per_base_unit || 0))),
      prescription_item_id: objectIdOrUndefined(rawItem.prescription_item_id || rawItem.prescriptionItemId),
      ipd_medication_chart_id: objectIdOrUndefined(rawItem.ipd_medication_chart_id || rawItem.medicationChartId),
      doctor_id: doctorId,
      doctor_name: doctorName,
      prescribed_by: doctorId,
      prescribed_by_name: doctorName,
      is_own_brand: Boolean(rawItem.is_own_brand ?? medicine.is_own_brand),
      commission_doctor_id: objectIdOrUndefined(rawItem.commission_doctor_id || rawItem.commissionDoctorId || medicine.commission_doctor_id || (medicine.is_own_brand ? doctorId : undefined)),
      commission_type: rawItem.commission_type || rawItem.commissionType || medicine.commission_type || 'None',
      commission_value: Number(rawItem.commission_value ?? rawItem.commissionValue ?? medicine.commission_value ?? 0),
      commission_amount: 0,
      _batch: batch,
      _medicine: medicine
    };

    if (item.commission_type === 'Percentage') {
      item.commission_amount = normalizeMoney(item.taxable_amount * item.commission_value / 100);
    } else if (item.commission_type === 'Fixed') {
      item.commission_amount = normalizeMoney(item.commission_value * item.quantity_base_units);
    }

    items.push(item);
  }

  return items;
}

// ========== calculateTotals ==========
function calculateTotals(items, { discount = 0, discount_type = 'percentage', tax_rate = null } = {}) {
  const itemGross = normalizeMoney(items.reduce((sum, item) => sum + Number(item.gross_amount || 0), 0));
  const itemDiscount = normalizeMoney(items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0));

  const afterItemDiscount = normalizeMoney(itemGross - itemDiscount);
  const billDiscountAmount = 0;
  const taxableBeforeBillTax = afterItemDiscount;

  let tax = normalizeMoney(items.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0));
  if (tax_rate != null && tax_rate !== '') {
    tax = normalizeMoney(taxableBeforeBillTax * Number(tax_rate || 0) / 100);
  }

  const total = normalizeMoney(taxableBeforeBillTax + tax);
  const purchaseCost = normalizeMoney(items.reduce((sum, item) => sum + Number(item.purchase_amount || 0), 0));
  const profit = normalizeMoney(taxableBeforeBillTax - purchaseCost);

  return {
    subtotal: afterItemDiscount,
    grossAmount: itemGross,
    itemDiscount,
    discountAmount: itemDiscount,
    taxableAmount: taxableBeforeBillTax,
    tax,
    total,
    purchaseCost,
    profit,
    commissionAmount: normalizeMoney(items.reduce((sum, item) => sum + Number(item.commission_amount || 0), 0))
  };
}

async function getPatientOutstanding({ patientId, admissionId, excludeSaleId } = {}) {
  if (!patientId && !admissionId) return 0;
  const match = { balance_due: { $gt: 0 }, status: { $nin: ['Cancelled', 'Refunded'] } };
  if (admissionId) match.admission_id = admissionId;
  else match.patient_id = patientId;
  if (excludeSaleId) match._id = { $ne: excludeSaleId };
  const rows = await Sale.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: '$balance_due' } } }]);
  return normalizeMoney(rows[0]?.amount || 0);
}

async function getPatientPharmacySummary({ patientId, admissionId } = {}) {
  const [outstanding, pharmacyAdvance, ipdAdvance] = await Promise.all([
    getPatientOutstanding({ patientId, admissionId }),
    getAdvanceBalance({ patientId, admissionId, walletType: 'PHARMACY_IPD' }),
    getAdvanceBalance({ patientId, admissionId, walletType: 'IPD_SHARED' })
  ]);
  return { outstanding, pharmacyAdvance, ipdAdvance };
}

async function deductStockAndCreateLedger({ items, hospitalId, pharmacyId, saleId, createdBy }) {
  for (const item of items) {
    const batch = await MedicineBatch.findById(item.batch_id);
    const current = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    const nextQty = current - Number(item.quantity_base_units || item.quantity || 0);
    if (nextQty < 0) throw new Error(`Insufficient stock for batch ${batch.batch_number}`);
    batch.quantity_base_units = nextQty;
    batch.quantity = nextQty;
    await batch.save();
    await InventoryLedger.create({
      hospitalId,
      pharmacyId,
      medicineId: item.medicine_id,
      batchId: item.batch_id,
      movementType: 'SALE_OUT',
      direction: 'OUT',
      quantityBaseUnits: item.quantity_base_units,
      balanceAfterBaseUnits: nextQty,
      sourceModule: 'PharmacySale',
      sourceId: saleId,
      notes: `Sale ${saleId}`,
      createdBy
    });
  }
}

async function restockAndCreateLedger({ items, hospitalId, pharmacyId, returnId, createdBy }) {
  for (const item of items) {
    if (!item.restock || !item.batchId) continue;
    const batch = await MedicineBatch.findById(item.batchId);
    if (!batch) continue;
    const current = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    const nextQty = current + Number(item.returnedQtyBaseUnits || 0);
    batch.quantity_base_units = nextQty;
    batch.quantity = nextQty;
    await batch.save();
    await InventoryLedger.create({
      hospitalId,
      pharmacyId,
      medicineId: item.medicineId,
      batchId: item.batchId,
      movementType: 'RETURN_IN',
      direction: 'IN',
      quantityBaseUnits: item.returnedQtyBaseUnits,
      balanceAfterBaseUnits: nextQty,
      sourceModule: 'PharmacyReturn',
      sourceId: returnId,
      notes: `Return ${returnId}`,
      createdBy
    });
  }
}

async function applyIpdMedicineStock({ items, sale, hospitalId, admissionId, patientId }) {
  if (!admissionId || !patientId) return [];
  const updates = [];
  for (const item of items) {
    const query = { admissionId, patientId, medicineId: item.medicine_id, batchId: item.batch_id };
    const update = {
      $setOnInsert: {
        hospitalId,
        admissionId,
        patientId,
        medicineId: item.medicine_id,
        batchId: item.batch_id,
        medicineName: item.medicine_name,
        baseUnit: item.base_unit,
        packUnit: item.pack_unit,
        unitsPerPack: item.units_per_pack
      },
      $inc: { issuedQtyBaseUnits: item.quantity_base_units, currentBalanceBaseUnits: item.quantity_base_units },
      $addToSet: { sourceSaleIds: sale._id, ...(item.ipd_medication_chart_id ? { medicationChartIds: item.ipd_medication_chart_id } : {}) },
      $set: { lastIssuedAt: new Date() }
    };
    const doc = await IPDPatientMedicineStock.findOneAndUpdate(query, update, { new: true, upsert: true });
    updates.push(doc);
  }
  return updates;
}

async function createSaleInvoice({ sale, items, customerName, customerPhone, totals, paymentEntries, createdBy, isDeferred = false }) {
  const customerType = sale.customer_type === 'WalkIn' || sale.customer_type === 'walkin' ? 'Walk-in' : 'Patient';
  const amountPaid = normalizeMoney(Math.min(sale.amount_paid || 0, sale.net_amount_after_returns || sale.total_amount || 0));

  let invoiceStatus = 'Pending';
  if (!isDeferred) {
    invoiceStatus = sale.balance_due <= 0 ? 'Paid' : amountPaid > 0 ? 'Partial' : 'Pending';
  }

  const grossAmount = totals.grossAmount;
  const discountAmount = totals.discountAmount;
  const taxAmount = totals.tax;
  const netTotal = totals.total;

  const invoiceSubtotal = grossAmount;
  const invoiceDiscount = discountAmount;
  const invoiceTax = taxAmount;
  const invoiceTotal = netTotal;

  const finalDiscount = sale.discount_amount > 0 ? sale.discount_amount : invoiceDiscount;
  const finalTotal = sale.total_amount || invoiceTotal;

  const invoice = await Invoice.create({
    invoice_type: 'Pharmacy',
    patient_id: sale.patient_id || undefined,
    admission_id: sale.admission_id || undefined,
    sale_id: sale._id,
    prescription_id: sale.prescription_id || undefined,
    customer_type: customerType,
    customer_name: customerName,
    customer_phone: customerPhone,
    issue_date: new Date(),
    due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    medicine_items: items.map(item => ({
      medicine_id: item.medicine_id,
      batch_id: item.batch_id,
      medicine_name: item.medicine_name,
      batch_number: item.batch_number,
      expiry_date: item.expiry_date,
      quantity: Math.max(1, item.quantity_base_units),
      unit_price: item.rate_per_base_unit,
      total_price: item.net_amount || item.total_price,
      tax_rate: item.tax_rate || 0,
      tax_amount: item.tax_amount || 0,
      taxable_amount: item.taxable_amount || 0,
      hsn_code: item.hsn_code,
      prescription_id: sale.prescription_id || undefined,
      is_dispensed: true,
      dispensed_at: new Date()
    })),
    subtotal: invoiceSubtotal,
    discount: finalDiscount,
    tax: invoiceTax,
    total: finalTotal,
    amount_paid: amountPaid,
    payments: paymentEntries.filter(p => !['Pending', 'Credit', 'NoPayment', 'Deferred'].includes(p.method)).map(p => ({
      amount: p.amount,
      method: ['Insurance', 'Government Scheme'].includes(p.method) ? 'Insurance' : p.method,
      reference: p.reference,
      collected_by: createdBy
    })).filter(p => p.amount > 0 && ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme'].includes(p.method)),
    status: invoiceStatus,
    is_pharmacy_sale: true,
    dispensing_date: new Date(),
    dispensed_by: createdBy,
    created_by: createdBy,
    notes: isDeferred ? `Deferred payment - ${sale.notes || ''}` : sale.notes
  });

  sale.invoice_id = invoice._id;
  sale.invoice_number = invoice.invoice_number;
  await sale.save();
  return invoice;
}

// In createPharmacyBill function, around line ~700-750

async function createPharmacyBill({ sale, items, totals, paymentEntries, hospitalId, patientId, admissionId, createdBy, isDeferred = false }) {
  const billItems = items.map(item => ({
    description: item.medicine_name,
    amount: item.net_amount || item.total_price,
    quantity: item.quantity_base_units,
    item_type: 'Pharmacy',
    medicine_id: item.medicine_id,
    batch_id: item.batch_id,
    medicine_name: item.medicine_name,
    batch_number: item.batch_number,
    expiry_date: item.expiry_date,
    base_unit: item.base_unit,
    quantity_base_units: item.quantity_base_units,
    unit_price: item.rate_per_base_unit,
    tax_rate: item.tax_rate || 0,
    tax_amount: item.tax_amount || 0,
    taxable_amount: item.taxable_amount || 0,
    discount_amount: item.discount_amount || 0,
    hsn_code: item.hsn_code,
    prescription_id: sale.prescription_id,
    prescription_item_id: item.prescription_item_id,
    admission_id: admissionId,
    doctor_id: item.doctor_id,
    doctor_name: item.doctor_name
  }));

  let pharmacyOutstandingBefore = 0;
  let pharmacyAdvanceBefore = 0;

  if (patientId) {
    const patient = await Patient.findById(patientId);
    if (patient) {
      pharmacyOutstandingBefore = patient.pharmacy_outstanding_balance || 0;
      pharmacyAdvanceBefore = patient.pharmacy_advance_balance || 0;
    }
  }

  let pharmacyAdvanceUsed = 0;
  let pharmacyAdvanceCreated = 0;
  let paymentAmount = 0;

  // Calculate payment amount correctly for deferred payments
  if (isDeferred || sale.payment_deferred === true) {
    // For deferred payments, amount_paid is what's paid towards the bill
    // If advance mode, amount_paid is 0 (all went to advance)
    paymentAmount = sale.amount_paid || 0;
  } else if (paymentEntries && paymentEntries.length > 0) {
    paymentAmount = paymentEntries.reduce((sum, p) => sum + p.amount, 0);
  } else if (sale.payment_method !== 'NoPayment' && sale.payment_method !== 'Pending' && sale.payment_method !== 'Deferred') {
    paymentAmount = totals.total;
  }

  // For deferred "advance" mode, the advance credit is tracked separately
  if (isDeferred || sale.payment_deferred === true) {
    // Check if this is "advance" mode - payment went to advance, not to bill
    const immediateAdvance = sale.immediate_advance_payment || sale.immediateAdvancePayment || 0;
    if (immediateAdvance > 0 && sale.amount_paid === 0) {
      // All collected amount went to advance, none to bill
      pharmacyAdvanceCreated = immediateAdvance;
    }
  }

  if (sale.payment_method === 'PharmacyAdvance' || (paymentEntries && paymentEntries.some(p => p.method === 'PharmacyAdvance'))) {
    pharmacyAdvanceUsed = Math.min(pharmacyAdvanceBefore, paymentAmount);
  }

  // Overpayment check - only for non-deferred payments
  let overpayment = 0;
  if (!isDeferred && !sale.payment_deferred) {
    if (paymentAmount > totals.total) {
      overpayment = paymentAmount - totals.total;
      pharmacyAdvanceCreated = overpayment;
    }
  }

  const pharmacyOutstandingAfter = Math.max(0, totals.total - paymentAmount + pharmacyOutstandingBefore - pharmacyAdvanceUsed);
  const pharmacyAdvanceAfter = pharmacyAdvanceBefore - pharmacyAdvanceUsed + pharmacyAdvanceCreated;

  // Determine bill status correctly
  let billStatus = 'Pending';
  if (!isDeferred && !sale.payment_deferred) {
    billStatus = sale.payment_method === 'NoPayment' ? 'Pending' : (paymentAmount >= totals.total ? 'Paid' : 'Partially Paid');
  } else {
    // For deferred payments, bill is not paid until the deferred amount is settled
    // But we track the advance credit separately
    billStatus = 'Pending';
  }

  const bill = await Bill.create({
    patient_id: patientId,
    admission_id: admissionId,
    prescription_id: sale.prescription_id,
    sale_id: sale._id,
    invoice_id: sale.invoice_id,
    total_amount: totals.total,
    subtotal: totals.subtotal,
    tax_amount: totals.tax,
    discount: totals.discountAmount,
    discount_type: sale.discount_type || 'percentage',
    payment_method: isDeferred || sale.payment_deferred ? 'Pending' : (sale.payment_method === 'Deferred' ? 'Pending' : sale.payment_method),
    payments: paymentEntries.map(p => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference,
      date: new Date()
    })),
    items: billItems,
    status: billStatus,
    paid_amount: paymentAmount,
    balance_due: totals.total - paymentAmount,
    created_by: createdBy,
    notes: isDeferred || sale.payment_deferred ? `Deferred payment - ${sale.notes || 'Pending settlement'}` : (sale.notes || `Pharmacy sale: ${sale.sale_number}`),
    is_pharmacy_bill: true,
    pharmacy_outstanding_before: pharmacyOutstandingBefore,
    pharmacy_outstanding_after: pharmacyOutstandingAfter,
    pharmacy_advance_used: pharmacyAdvanceUsed,
    pharmacy_advance_created: pharmacyAdvanceCreated,
    advance_balance_after: pharmacyAdvanceAfter
  });

  sale.bill_id = bill._id;
  await sale.save();

  // Update patient balances - for deferred payments, outstanding balance increases
  if (patientId) {
    if (isDeferred || sale.payment_deferred) {
      // Deferred payment: outstanding balance is the full bill amount
      // The advance credit is already added to pharmacy_advance_balance
      await Patient.findByIdAndUpdate(patientId, {
        $inc: {
          pharmacy_outstanding_balance: totals.total - paymentAmount,
          // pharmacy_advance_balance is already updated when advance was credited
        },
        last_pharmacy_transaction: new Date()
      });
    } else {
      await Patient.findByIdAndUpdate(patientId, {
        $inc: {
          pharmacy_outstanding_balance: (totals.total - paymentAmount - pharmacyAdvanceUsed),
          pharmacy_advance_balance: (pharmacyAdvanceCreated - pharmacyAdvanceUsed)
        },
        last_pharmacy_transaction: new Date()
      });
    }
  }

  return bill;
}

async function createIpdChargeForSale({ sale, total, createdBy, isDeferred = false }) {
  if (!sale.admission_id || !sale.patient_id) return null;
  return IPDCharge.create({
    admissionId: sale.admission_id,
    patientId: sale.patient_id,
    chargeType: 'Pharmacy',
    description: isDeferred ? `Pharmacy medicines - ${sale.sale_number} (Deferred Payment)` : `Pharmacy medicines - ${sale.sale_number}`,
    quantity: 1,
    rate: total,
    amount: total,
    netAmount: total,
    sourceModule: 'Pharmacy',
    sourceId: sale._id,
    isAutoGenerated: true,
    isBilled: false,
    invoiceId: sale.invoice_id,
    addedBy: createdBy,
    notes: isDeferred ? 'Deferred payment - pending settlement at discharge' : 'Auto-created from pharmacy sale'
  });
}

async function validateAdvancePayment({ p, patientId, admissionId }) {
  if (!['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) return;
  if (!admissionId || !patientId) throw new Error(`${p.method} can only be used for admitted IPD patients.`);
  const walletType = p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED');
  const balance = await getAdvanceBalance({ admissionId, patientId, walletType });
  if (balance + 0.01 < p.amount) throw new Error(`Insufficient ${walletType} balance. Available ₹${balance}, needed ₹${p.amount}.`);
}

function allocatePaymentsForAmount(payments, amount) {
  let remaining = normalizeMoney(amount);
  const allocated = [];
  for (const p of payments || []) {
    if (remaining <= 0) break;
    const use = normalizeMoney(Math.min(remaining, p.amount || 0));
    if (use <= 0) continue;
    allocated.push({ ...p, amount: use });
    remaining = normalizeMoney(remaining - use);
  }
  return allocated;
}

async function consumeAdvancePayment({ p, sale, hospitalId, patientId, admissionId, createdBy }) {
  if (!['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) return;
  if (!admissionId || !patientId) throw new Error(`${p.method} can only be used for admitted IPD patients.`);
  const walletType = p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED');
  const balance = await getAdvanceBalance({ admissionId, patientId, walletType });
  if (balance + 0.01 < p.amount) throw new Error(`Insufficient ${walletType} balance. Available ₹${balance}, needed ₹${p.amount}.`);
  await createAdvanceLedgerEntry({
    hospitalId,
    patientId,
    admissionId,
    walletType,
    transactionType: 'PHARMACY_SALE_DEBIT',
    direction: 'DEBIT',
    amount: p.amount,
    paymentMethod: p.method,
    referenceNumber: p.reference,
    sourceModule: 'Pharmacy',
    sourceId: sale._id,
    notes: `Pharmacy sale/payment ${sale.sale_number}`,
    createdBy
  });
}

async function createPharmacyLedgerForPayments({ payments, sale, hospitalId, pharmacyId, createdBy, entryType = 'SALE' }) {
  for (const p of payments) {
    if (!p.amount) continue;
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: ['IPDAdvance', 'PharmacyAdvance'].includes(p.method) ? 'ADVANCE_USED' : entryType,
      direction: ['IPDAdvance', 'PharmacyAdvance'].includes(p.method) ? 'NON_CASH' : paymentCashDirection(p.method),
      amount: normalizeMoney(p.amount),
      paymentMethod: p.method,
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: p.notes || `Payment for ${sale.sale_number}`,
      createdBy
    });
  }
}

async function allocatePaymentToOutstanding({ patientId, admissionId, hospitalId, pharmacyId, createdBy, sale, amount, payments }) {
  let remaining = normalizeMoney(amount);
  const allocations = [];
  if (!remaining || (!patientId && !admissionId)) return { allocated: 0, remaining, allocations };
  const query = { balance_due: { $gt: 0 }, status: { $nin: ['Cancelled', 'Refunded'] } };
  if (admissionId) query.admission_id = admissionId;
  else query.patient_id = patientId;
  if (sale?._id) query._id = { $ne: sale._id };
  const pendingSales = await Sale.find(query).sort({ sale_date: 1 });
  for (const pending of pendingSales) {
    if (remaining <= 0) break;
    const pay = normalizeMoney(Math.min(remaining, pending.balance_due || 0));
    if (pay <= 0) continue;
    pending.amount_paid = normalizeMoney((pending.amount_paid || 0) + pay);
    pending.balance_due = normalizeMoney((pending.balance_due || 0) - pay);
    pending.status = pending.balance_due <= 0 ? 'Completed' : 'Pending';
    pending.settlement_refs = pending.settlement_refs || [];
    pending.settlement_refs.push({ sale_id: sale?._id, amount: pay, settled_at: new Date() });
    await pending.save();
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'OUTSTANDING_PAYMENT',
      direction: 'IN',
      amount: pay,
      paymentMethod: payments?.[0]?.method || 'Cash',
      patientId: pending.patient_id || patientId,
      admissionId: pending.admission_id || admissionId,
      saleId: pending._id,
      invoiceId: pending.invoice_id,
      notes: `Outstanding cleared via ${sale?.sale_number || 'payment'}`,
      createdBy
    });
    allocations.push({ saleId: pending._id, saleNumber: pending.sale_number, amount: pay });
    remaining = normalizeMoney(remaining - pay);
  }
  return { allocated: normalizeMoney(amount - remaining), remaining, allocations };
}

// ========== UPDATED: createUnifiedSale - Support "Pay Less Now" feature ==========
async function createUnifiedSale(payload, req = {}) {
  console.log('Creating unified sale with payload:', payload);
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId);
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId);
  const prescriptionId = objectIdOrUndefined(payload.prescription_id || payload.prescriptionId);
  const context = await resolvePatientContext({ patientId, admissionId, prescriptionId, explicit: payload });

  // ========== CHECK FOR "PAY LESS NOW" FEATURE ==========
  // New field from frontend: immediate_payment_to_advance
  const immediateAdvancePayment = normalizeMoney(payload.immediate_payment_to_advance || 0);
  const immediateAdvanceMethod = payload.immediate_payment_method || 'Cash';

  // CREATE/UPDATE CUSTOMER RECORD
  let customerId = null;
  const customerPhone = payload.customer_phone || context.patientPhone;
  const customerName = payload.customer_name || context.patientName;
  const customerEmail = payload.customer_email || null;
  const customerAddress = payload.customer_address || null;
  const customerType = payload.customer_type || payload.customerType || (patientId ? 'Patient' : 'Walk-in');

  let mappedCustomerType = 'Walk-in';
  if (customerType === 'Patient' || customerType === 'patient') mappedCustomerType = 'Patient';
  else if (customerType === 'Regular' || customerType === 'regular') mappedCustomerType = 'Regular';
  else if (customerType === 'Corporate' || customerType === 'corporate') mappedCustomerType = 'Corporate';
  else if (customerType === 'Insurance' || customerType === 'insurance') mappedCustomerType = 'Insurance';
  else if (customerType === 'Walk-in' || customerType === 'walkin' || customerType === 'WalkIn') mappedCustomerType = 'Walk-in';

  if (customerPhone) {
    try {
      const Customer = mongoose.model('Customer');
      let customer = await Customer.findOne({ phone: customerPhone });

      if (!customer) {
        customer = await Customer.create({
          name: customerName || (mappedCustomerType === 'Patient' ? 'Patient' : `${mappedCustomerType} Customer`),
          phone: customerPhone,
          email: customerEmail,
          address: customerAddress,
          customer_type: mappedCustomerType,
          patient_id: patientId || null,
          total_spent: 0,
          loyalty_points: 0,
          is_active: true,
          created_by: createdBy
        });
        console.log(`Created new customer: ${customer.name} (${customer.phone}) - Type: ${mappedCustomerType}`);
      } else {
        let needsUpdate = false;
        if (customerName && customer.name !== customerName && (customer.name === 'Walk-in Customer' || customer.name === `${customer.customer_type} Customer`)) {
          customer.name = customerName;
          needsUpdate = true;
        }
        if (customerEmail && !customer.email) {
          customer.email = customerEmail;
          needsUpdate = true;
        }
        if (customerAddress && !customer.address) {
          customer.address = customerAddress;
          needsUpdate = true;
        }
        if (patientId && !customer.patient_id) {
          customer.patient_id = patientId;
          needsUpdate = true;
        }
        if (mappedCustomerType !== 'Walk-in' && customer.customer_type === 'Walk-in') {
          customer.customer_type = mappedCustomerType;
          needsUpdate = true;
        }
        if (needsUpdate) {
          await customer.save();
          console.log(`Updated existing customer: ${customer.name} (${customer.phone})`);
        }
      }
      customerId = customer._id;
    } catch (err) {
      console.error('Error creating/updating customer:', err);
    }
  }

  const items = await buildSaleItems(payload.items || [], {
    honorLooseSale: payload.allowLooseSale !== false,
    defaultDoctor: { doctorId: context.doctorId, doctorName: context.doctorName },
    billDiscount: payload.discount || 0,
    billDiscountType: payload.discount_type || 'percentage'
  });

  const totals = calculateTotals(items, payload);
  const previousOutstanding = await getPatientOutstanding({ patientId, admissionId });
  const previousPharmacyAdvance = await getAdvanceBalance({ patientId, admissionId, walletType: 'PHARMACY_IPD' });
  const noPayment = payload.noPayment === true || payload.pay_nothing === true;

  const deferPayment = payload.payment_deferred === true ||
    payload.defer_payment === true ||
    payload.payment_method === 'Deferred' ||
    payload.payment_method === 'Defer' ||
    payload.payment_method === 'Will Pay Later';

  const paymentDeferred = deferPayment || noPayment;

  let deferralReason = undefined;
  if (paymentDeferred) {
    deferralReason = payload.deferral_reason || payload.defer_reason || 'will_pay_later';
  }

  const expectedPaymentDate = payload.expected_payment_date ? new Date(payload.expected_payment_date) : null;
  const includeInDischargeClearance = payload.include_in_discharge_clearance !== false;

  // ========== IF PAYMENT IS DEFERRED (including "Pay Less Now") ==========
  if (paymentDeferred) {
    console.log('Processing deferred payment sale...');

    // Calculate the actual balance due
    // If there's an immediate advance payment, the balance due is the full total
    // (the payment goes to advance, not to the bill)
    let balanceDue = totals.total;
    let amountPaid = 0;
    let totalCollected = 0;

    // Check if there's any manual payment that goes to the bill
    if (payload.payments && payload.payments.length > 0) {
      const manualPayments = payload.payments.map(p => ({
        method: p.method,
        amount: normalizeMoney(p.amount),
        reference: p.reference || null
      }));
      // Sum up payments that are NOT going to advance
      const paymentSum = manualPayments.reduce((sum, p) => sum + p.amount, 0);

      // If there's immediate advance payment, subtract it from total collected
      if (immediateAdvancePayment > 0) {
        // The payment is going to advance, not to the bill
        totalCollected = paymentSum;
        amountPaid = 0;
        balanceDue = totals.total;
      } else {
        // Regular deferred with partial payment
        amountPaid = Math.min(paymentSum, totals.total);
        balanceDue = totals.total - amountPaid;
        totalCollected = paymentSum;
      }
    }

    // Check if there's an immediate advance payment (Pay Less Now with "Add to Advance" mode)
    if (immediateAdvancePayment > 0) {
      console.log(`💰 Processing immediate advance payment: ${immediateAdvancePayment} via ${immediateAdvanceMethod}`);

      // Validate that we have an IPD patient
      if (!patientId || !admissionId) {
        throw new Error('Immediate advance payment requires an IPD patient with an active admission.');
      }

      // The advance payment is credited separately later
      // Balance due remains the full total
      balanceDue = totals.total;
      amountPaid = 0;
      totalCollected = immediateAdvancePayment;
    }

    const sale = await Sale.create({
      hospitalId,
      pharmacy_id: pharmacyId,
      customer_type: payload.customer_type || payload.customerType || (admissionId ? 'IPD' : patientId ? 'OPD' : 'WalkIn'),
      source_type: payload.source_type || payload.sourceType || (admissionId ? 'IPD_MEDICATION' : prescriptionId ? 'OPD_PRESCRIPTION' : 'DIRECT'),
      patient_id: patientId,
      admission_id: admissionId,
      prescription_id: prescriptionId,
      doctor_id: context.doctorId,
      doctor_name: context.doctorName,
      uhid: context.uhid,
      registration_number: context.registrationNumber,
      ship_no: context.shipNo,
      sponsor_type: context.sponsorType,
      sponsor_name: context.sponsorName,
      customer_name: context.patientName,
      customer_phone: context.patientPhone,
      items: items.map(({ _batch, _medicine, ...item }) => item),
      subtotal: totals.subtotal,
      gross_amount: totals.grossAmount,
      item_discount_amount: totals.itemDiscount,
      discount: Number(payload.discount || 0),
      discount_type: payload.discount_type || payload.discountType || 'percentage',
      discount_amount: totals.discountAmount,
      taxable_amount: totals.taxableAmount,
      discount_reason: payload.discount_reason || payload.discountReason || (paymentDeferred ? 'Payment deferred' : undefined),
      discount_approved_by: objectIdOrUndefined(payload.discount_approved_by || payload.discountApprovedBy),
      tax_rate: payload.tax_rate || payload.taxRate || 0,
      tax: totals.tax,
      total_amount: totals.total,
      current_bill_amount: totals.total,
      previous_outstanding: previousOutstanding,
      amount_paid: amountPaid,
      total_collected_amount: totalCollected,
      settlement_amount: 0,
      balance_due: balanceDue,
      closing_outstanding: normalizeMoney(previousOutstanding + balanceDue),
      pharmacy_advance_before: previousPharmacyAdvance,
      overpayment_amount: 0,
      overpayment_credited_to: null,
      total_purchase_cost: totals.purchaseCost,
      gross_profit: totals.profit,
      commission_amount: totals.commissionAmount,
      return_amount: 0,
      net_amount_after_returns: totals.total,
      payment_method: payload.payment_method || 'Deferred',
      payments: payload.payments || [],
      status: balanceDue <= 0 ? 'Completed' : 'Pending',
      notes: payload.notes || `Payment deferred. Reason: ${deferralReason}`,
      created_by: createdBy,
      bill_date: payload.bill_date || new Date(),
      created_by_name: payload.created_by_name,
      payment_deferred: true,
      deferral_reason: deferralReason,
      expected_payment_date: expectedPaymentDate,
      include_in_discharge_clearance: includeInDischargeClearance,
      // Store the immediate advance payment info for reference
      immediate_advance_payment: immediateAdvancePayment > 0 ? {
        amount: immediateAdvancePayment,
        method: immediateAdvanceMethod
      } : null
    });

    // ========== PROCESS IMMEDIATE ADVANCE PAYMENT ==========
    if (immediateAdvancePayment > 0 && patientId && admissionId) {
      console.log(`✨ Crediting ${immediateAdvancePayment} to Pharmacy Advance for sale ${sale.sale_number}`);

      // Credit to pharmacy advance
      await createAdvanceLedgerEntry({
        hospitalId,
        patientId,
        admissionId,
        walletType: 'PHARMACY_IPD',
        transactionType: 'PHARMACY_LESS_PAYMENT_ADVANCE',
        direction: 'CREDIT',
        amount: immediateAdvancePayment,
        paymentMethod: immediateAdvanceMethod,
        referenceNumber: sale.sale_number,
        sourceModule: 'Pharmacy',
        sourceId: sale._id,
        notes: `Less payment (₹${immediateAdvancePayment}) credited to pharmacy advance for deferred sale ${sale.sale_number}`,
        createdBy
      });

      // Create pharmacy ledger entry
      await PharmacyLedgerEntry.create({
        hospitalId,
        pharmacyId,
        entryType: 'ADVANCE_RECEIVED',
        direction: 'IN',
        amount: immediateAdvancePayment,
        paymentMethod: immediateAdvanceMethod,
        patientId,
        admissionId,
        saleId: sale._id,
        invoiceId: sale.invoice_id,
        notes: `Less payment (₹${immediateAdvancePayment}) credited to pharmacy advance for ${sale.sale_number}`,
        createdBy
      });

      // Update patient's pharmacy advance balance
      await Patient.findByIdAndUpdate(patientId, {
        $inc: { pharmacy_advance_balance: immediateAdvancePayment },
        last_pharmacy_transaction: new Date()
      });

      console.log(`✅ Successfully credited ₹${immediateAdvancePayment} to Pharmacy Advance`);
    }

    // Process regular payments (if any) - these go to the bill
    if (payload.payments && payload.payments.length > 0 && immediateAdvancePayment === 0) {
      const paymentEntries = payload.payments.map(p => ({
        method: p.method,
        amount: normalizeMoney(p.amount),
        reference: p.reference || null
      }));

      // Deduct advance if applicable
      for (const p of paymentEntries) {
        if (['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) {
          await consumeAdvancePayment({ p, sale, hospitalId, patientId, admissionId, createdBy });
        }
      }

      // Create payment ledger entries
      await createPharmacyLedgerForPayments({
        payments: paymentEntries,
        sale,
        hospitalId,
        pharmacyId,
        createdBy,
        entryType: 'SALE'
      });
    }

    const invoice = await createSaleInvoice({
      sale,
      items,
      customerName: sale.customer_name,
      customerPhone: sale.customer_phone,
      totals,
      paymentEntries: [],
      createdBy,
      isDeferred: true
    });

    const bill = await createPharmacyBill({
      sale,
      items,
      totals,
      paymentEntries: [],
      hospitalId,
      patientId,
      admissionId,
      createdBy,
      isDeferred: true
    });

    if (sale.admission_id && sale.patient_id) {
      await createIpdChargeForSale({ sale, total: totals.total, createdBy, isDeferred: true });
    }

    await applyIpdMedicineStock({ items, sale, hospitalId, admissionId, patientId });

    // Create due ledger entry for the deferred amount
    if (balanceDue > 0) {
      await PharmacyLedgerEntry.create({
        hospitalId,
        pharmacyId,
        entryType: 'DUE_CREATED',
        direction: 'OUT',
        amount: balanceDue,
        paymentMethod: 'Deferred',
        patientId,
        admissionId,
        saleId: sale._id,
        invoiceId: sale.invoice_id,
        notes: `Deferred payment: ${deferralReason} | ${sale.sale_number}`,
        createdBy
      });
    }

    if (patientId && balanceDue > 0) {
      await Patient.findByIdAndUpdate(patientId, {
        $inc: { pharmacy_outstanding_balance: balanceDue },
        last_pharmacy_transaction: new Date()
      });
    }

    if (customerId) {
      const Customer = mongoose.model('Customer');
      await Customer.findByIdAndUpdate(customerId, {
        $inc: { total_spent: totals.total },
        $set: { last_purchase_date: new Date() }
      });
    }

    if (prescriptionId) {
      const prescription = await Prescription.findById(prescriptionId);
      if (prescription) {
        prescription.items.forEach((rxItem) => {
          const matched = items.find(item => String(item.prescription_item_id || '') === String(rxItem._id) || item.medicine_name === rxItem.medicine_name);
          if (matched) {
            rxItem.is_dispensed = true;
            rxItem.dispensed_quantity = matched.quantity_base_units;
            rxItem.dispensed_date = new Date();
          }
        });
        if (prescription.items.every(item => item.is_dispensed)) prescription.status = 'Completed';
        await prescription.save();
      }
    }

    for (const item of items) {
      if (item.ipd_medication_chart_id) {
        await IPDMedicationChart.findByIdAndUpdate(item.ipd_medication_chart_id, {
          status: 'Active',
          'pharmacyRequest.pharmacyStatus': 'Dispatched',
          'pharmacyRequest.dispensedFromPharmacy': true,
          'pharmacyRequest.dispensedQuantity': item.quantity_base_units,
          'pharmacyRequest.dispensedBatchId': item.batch_id,
          'pharmacyRequest.dispensedAt': new Date()
        });
      }
    }

    const finalSummary = await getPatientPharmacySummary({ patientId, admissionId });
    sale.closing_outstanding = finalSummary.outstanding;
    sale.pharmacy_advance_after = finalSummary.pharmacyAdvance;
    await sale.save();

    const populatedSale = await Sale.findById(sale._id)
      .populate('patient_id', 'first_name middle_name last_name patientId uhid phone gender dob')
      .populate({
        path: 'admission_id',
        select: 'admissionNumber status paymentType advanceAmount bedId wardId',
        populate: [
          { path: 'bedId', model: 'Bed', select: 'bedNumber bed_number bedName' },
          { path: 'wardId', model: 'Ward', select: 'name wardName' }
        ]
      })
      .populate('doctor_id', 'firstName lastName name')
      .populate('items.medicine_id', 'name composition generic_name brand base_unit pack_unit units_per_pack hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .lean();

    return {
      sale: populatedSale,
      invoice,
      bill,
      paymentDeferred: true,
      deferredAmount: balanceDue,
      deferralReason: deferralReason,
      previous_outstanding: previousOutstanding,
      balances: finalSummary,
      customerId: customerId,
      immediate_advance_payment: immediateAdvancePayment > 0 ? {
        amount: immediateAdvancePayment,
        method: immediateAdvanceMethod
      } : null,
      pharmacy_advance_credit_amount: immediateAdvancePayment,
      pharmacy_advance_after: finalSummary.pharmacyAdvance,
      total_collected_amount: totalCollected
    };
  }

  // ========== HANDLE PAYMENTS FROM PAYLOAD (NON-DEFERRED) ==========
  const explicitOverpaymentAmount = normalizeMoney(payload.overpayment_amount || 0);
  const explicitOverpaymentAdvance = payload.overpayment_advance || null;

  let payments = [];
  let totalReceived = 0;
  let overpaymentToAdvance = 0;
  let outstandingPaymentAmount = 0;

  const frontendTotalCollected = normalizeMoney(payload.total_collected_amount || 0);

  if (payload.payments && payload.payments.length > 0) {
    payments = payload.payments.map(p => ({
      method: p.method,
      amount: normalizeMoney(p.amount),
      reference: p.reference || null,
      walletType: p.walletType || null
    }));

    totalReceived = normalizeMoney(payments.reduce((sum, p) => sum + p.amount, 0));

    console.log(`💰 Payments sum: ${totalReceived}, Frontend total collected: ${frontendTotalCollected}, Bill total: ${totals.total}`);

    const paymentForCurrent = Math.min(totalReceived, totals.total);
    const extraTendered = normalizeMoney(Math.max(0, totalReceived - paymentForCurrent));

    if (explicitOverpaymentAmount > 0 && explicitOverpaymentAdvance) {
      overpaymentToAdvance = explicitOverpaymentAmount;
      outstandingPaymentAmount = normalizeMoney(Math.max(0, extraTendered - overpaymentToAdvance));
      console.log(`📝 Using explicit overpayment: ${overpaymentToAdvance}`);
    } else {
      const shouldSettleOutstanding = payload.payOutstanding === true || payload.pay_outstanding === true || Number(payload.outstanding_payment_amount || 0) > 0;
      const requestedOutstandingPayment = shouldSettleOutstanding
        ? normalizeMoney(payload.outstanding_payment_amount || previousOutstanding)
        : 0;
      outstandingPaymentAmount = normalizeMoney(Math.min(extraTendered, requestedOutstandingPayment || extraTendered, previousOutstanding));
      overpaymentToAdvance = normalizeMoney(Math.max(0, extraTendered - outstandingPaymentAmount));
      console.log(`💰 Overpayment to advance: ${overpaymentToAdvance}, Outstanding payment: ${outstandingPaymentAmount}`);
    }
  } else {
    payments = normalizePayments({ total: totals.total, payment_method: payload.payment_method || payload.paymentMethod, payments: payload.payments, noPayment });
    totalReceived = normalizeMoney(payments.reduce((sum, p) => sum + p.amount, 0));
    const paymentForCurrent = Math.min(totalReceived, totals.total);
    const extraTendered = normalizeMoney(Math.max(0, totalReceived - paymentForCurrent));

    if (explicitOverpaymentAmount > 0 && explicitOverpaymentAdvance) {
      overpaymentToAdvance = explicitOverpaymentAmount;
      outstandingPaymentAmount = normalizeMoney(Math.max(0, extraTendered - overpaymentToAdvance));
    } else {
      const shouldSettleOutstanding = payload.payOutstanding === true || payload.pay_outstanding === true;
      outstandingPaymentAmount = shouldSettleOutstanding ? Math.min(extraTendered, previousOutstanding) : 0;
      overpaymentToAdvance = normalizeMoney(Math.max(0, extraTendered - outstandingPaymentAmount));
    }
  }

  for (const p of payments) {
    await validateAdvancePayment({ p, patientId, admissionId });
  }

  const totalCollectedAmount = frontendTotalCollected > 0 ? frontendTotalCollected : normalizeMoney(totalReceived);
  const amountPaidForBill = normalizeMoney(Math.min(totalReceived, totals.total));
  const overpaymentAmount = normalizeMoney(Math.max(0, totalCollectedAmount - amountPaidForBill));
  const balanceDue = noPayment ? totals.total : normalizeMoney(Math.max(0, totals.total - amountPaidForBill));
  const saleStatus = balanceDue <= 0 ? 'Completed' : 'Pending';

  console.log(`💵 TOTAL COLLECTED: ${totalCollectedAmount} | Used for bill: ${amountPaidForBill} | Overpayment to advance: ${overpaymentAmount} | Balance due: ${balanceDue}`);

  const sale = await Sale.create({
    hospitalId,
    pharmacy_id: pharmacyId,
    customer_type: payload.customer_type || payload.customerType || (admissionId ? 'IPD' : patientId ? 'OPD' : 'WalkIn'),
    source_type: payload.source_type || payload.sourceType || (admissionId ? 'IPD_MEDICATION' : prescriptionId ? 'OPD_PRESCRIPTION' : 'DIRECT'),
    patient_id: patientId,
    admission_id: admissionId,
    prescription_id: prescriptionId,
    doctor_id: context.doctorId,
    doctor_name: context.doctorName,
    uhid: context.uhid,
    registration_number: context.registrationNumber,
    ship_no: context.shipNo,
    sponsor_type: context.sponsorType,
    sponsor_name: context.sponsorName,
    customer_name: context.patientName,
    customer_phone: context.patientPhone,
    items: items.map(({ _batch, _medicine, ...item }) => item),
    subtotal: totals.subtotal,
    gross_amount: totals.grossAmount,
    item_discount_amount: totals.itemDiscount,
    discount: Number(payload.discount || 0),
    discount_type: payload.discount_type || payload.discountType || 'percentage',
    discount_amount: totals.discountAmount,
    taxable_amount: totals.taxableAmount,
    discount_reason: payload.discount_reason || payload.discountReason,
    discount_approved_by: objectIdOrUndefined(payload.discount_approved_by || payload.discountApprovedBy),
    tax_rate: payload.tax_rate || payload.taxRate || 0,
    tax: totals.tax,
    total_amount: totals.total,
    current_bill_amount: totals.total,
    previous_outstanding: previousOutstanding,
    amount_paid: amountPaidForBill,
    total_collected_amount: totalCollectedAmount,
    settlement_amount: outstandingPaymentAmount,
    balance_due: balanceDue,
    closing_outstanding: normalizeMoney(previousOutstanding - outstandingPaymentAmount + balanceDue),
    pharmacy_advance_before: previousPharmacyAdvance,
    overpayment_amount: overpaymentAmount,
    overpayment_credited_to: overpaymentAmount > 0 ? 'PHARMACY_IPD' : null,
    total_purchase_cost: totals.purchaseCost,
    gross_profit: totals.profit,
    commission_amount: totals.commissionAmount,
    return_amount: 0,
    net_amount_after_returns: totals.total,
    payment_method: noPayment ? 'Pending' : payments.length > 1 ? 'Split' : payments[0]?.method || 'Pending',
    payments: payments,
    status: saleStatus,
    notes: payload.notes,
    created_by: createdBy,
    bill_date: payload.bill_date || new Date(),
    created_by_name: payload.created_by_name,
  });

  await deductStockAndCreateLedger({ items, hospitalId, pharmacyId, saleId: sale._id, createdBy });
  const invoice = await createSaleInvoice({ sale, items, customerName: sale.customer_name, customerPhone: sale.customer_phone, totals, paymentEntries: payments, createdBy, isDeferred: false });
  const bill = await createPharmacyBill({ sale, items, totals, paymentEntries: payments, hospitalId, patientId, admissionId, createdBy, isDeferred: false });
  await createIpdChargeForSale({ sale, total: totals.total, createdBy, isDeferred: false });
  await applyIpdMedicineStock({ items, sale, hospitalId, admissionId, patientId });

  const currentPaymentBreakup = allocatePaymentsForAmount(payments, amountPaidForBill);
  for (const p of currentPaymentBreakup) {
    await consumeAdvancePayment({ p, sale, hospitalId, patientId, admissionId, createdBy });
  }
  await createPharmacyLedgerForPayments({ payments: currentPaymentBreakup, sale, hospitalId, pharmacyId, createdBy, entryType: 'SALE' });

  if (balanceDue > 0) {
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'DUE_CREATED',
      direction: 'NON_CASH',
      amount: balanceDue,
      paymentMethod: 'Credit',
      patientId,
      admissionId,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Outstanding created for ${sale.sale_number}`,
      createdBy
    });
  }

  let outstandingAllocation = { allocated: 0, remaining: 0, allocations: [] };
  if (outstandingPaymentAmount > 0) {
    outstandingAllocation = await allocatePaymentToOutstanding({ patientId, admissionId, hospitalId, pharmacyId, createdBy, sale, amount: outstandingPaymentAmount, payments });
  }

  if (overpaymentAmount > 0 && patientId) {
    console.log(`✨ Creating advance entry for overpayment: ${overpaymentAmount}`);
    const overpaymentSourcePayment = payments.find(p => p.amount > 0) || { method: 'Cash', reference: null };

    await createAdvanceLedgerEntry({
      hospitalId,
      patientId,
      admissionId,
      walletType: 'PHARMACY_IPD',
      transactionType: 'PHARMACY_OVERPAYMENT_CREDIT',
      direction: 'CREDIT',
      amount: overpaymentAmount,
      paymentMethod: overpaymentSourcePayment.method,
      referenceNumber: overpaymentSourcePayment.reference,
      sourceModule: 'Pharmacy',
      sourceId: sale._id,
      notes: `Extra payment credited to pharmacy advance from ${sale.sale_number}`,
      createdBy
    });

    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'ADVANCE_RECEIVED',
      direction: 'NON_CASH',
      amount: overpaymentAmount,
      paymentMethod: overpaymentSourcePayment.method,
      patientId,
      admissionId,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Extra payment (₹${overpaymentAmount}) credited to pharmacy advance for ${sale.sale_number}`,
      createdBy
    });

    console.log(`✅ Successfully created advance entry for ₹${overpaymentAmount}`);
  }

  if (customerId) {
    const Customer = mongoose.model('Customer');
    await Customer.findByIdAndUpdate(customerId, {
      $inc: { total_spent: totals.total },
      $set: { last_purchase_date: new Date() }
    });
  }

  if (prescriptionId) {
    const prescription = await Prescription.findById(prescriptionId);
    if (prescription) {
      prescription.items.forEach((rxItem) => {
        const matched = items.find(item => String(item.prescription_item_id || '') === String(rxItem._id) || item.medicine_name === rxItem.medicine_name);
        if (matched) {
          rxItem.is_dispensed = true;
          rxItem.dispensed_quantity = matched.quantity_base_units;
          rxItem.dispensed_date = new Date();
        }
      });
      if (prescription.items.every(item => item.is_dispensed)) prescription.status = 'Completed';
      await prescription.save();
    }
  }

  for (const item of items) {
    if (item.ipd_medication_chart_id) {
      await IPDMedicationChart.findByIdAndUpdate(item.ipd_medication_chart_id, {
        status: 'Active',
        'pharmacyRequest.pharmacyStatus': 'Dispatched',
        'pharmacyRequest.dispensedFromPharmacy': true,
        'pharmacyRequest.dispensedQuantity': item.quantity_base_units,
        'pharmacyRequest.dispensedBatchId': item.batch_id,
        'pharmacyRequest.dispensedAt': new Date()
      });
    }
  }

  const finalSummary = await getPatientPharmacySummary({ patientId, admissionId });
  sale.closing_outstanding = finalSummary.outstanding;
  sale.pharmacy_advance_after = finalSummary.pharmacyAdvance;
  await sale.save();

  const populatedSale = await Sale.findById(sale._id)
    .populate('patient_id', 'first_name middle_name last_name patientId uhid phone gender dob')
    .populate({
      path: 'admission_id',
      select: 'admissionNumber status paymentType advanceAmount bedId wardId',
      populate: [
        { path: 'bedId', model: 'Bed', select: 'bedNumber bed_number bedName' },
        { path: 'wardId', model: 'Ward', select: 'name wardName' }
      ]
    })
    .populate('doctor_id', 'firstName lastName name')
    .populate('items.medicine_id', 'name composition generic_name brand base_unit pack_unit units_per_pack hsn_code gst_rate')
    .populate('items.batch_id', 'batch_number expiry_date')
    .lean();

  return {
    sale: populatedSale,
    invoice,
    bill,
    previous_outstanding: previousOutstanding,
    outstanding_settlement: outstandingAllocation,
    overpayment_advance: overpaymentAmount > 0 ? {
      amount: overpaymentAmount,
      credited_to: 'PHARMACY_IPD'
    } : null,
    balances: finalSummary,
    customerId: customerId,
    pharmacy_advance_credit_amount: overpaymentAmount,
    pharmacy_advance_after: finalSummary.pharmacyAdvance,
    total_collected_amount: totalCollectedAmount
  };
}

// ========== UPDATED: createReturn - Handle deferred payment returns ==========
async function createReturn(payload, req = {}) {
  console.log('========== CREATE RETURN START ==========');
  console.log('Creating pharmacy return with payload:', JSON.stringify(payload, null, 2));

  const round2 = (value) =>
    Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  const clampMoney = (value) => Math.max(0, round2(value));

  const sumMoney = (arr, selector) =>
    round2((arr || []).reduce((sum, item) => sum + Number(selector(item) || 0), 0));

  const cashRefundModes = ['Cash', 'UPI', 'Card'];

  const idsEqual = (a, b) => {
    if (!a || !b) return false;
    return String(a) === String(b);
  };

  const calculateReturnAccounting = ({
    currentSubtotal,
    currentDiscount,
    returnedTaxable,
    suppliedDiscountReversal
  }) => {
    const subtotalBefore = Number(currentSubtotal || 0);
    const discountBefore = Number(currentDiscount || 0);
    const taxableReturned = Number(returnedTaxable || 0);
    const suppliedDiscount = Number(suppliedDiscountReversal || 0);

    if (suppliedDiscount > 0) {
      return {
        returnedGrossBeforeDiscount: round2(taxableReturned + suppliedDiscount),
        discountReversal: round2(suppliedDiscount)
      };
    }

    const discountRatio =
      subtotalBefore > 0
        ? discountBefore / subtotalBefore
        : 0;

    const safeDiscountRatio =
      discountRatio >= 0 && discountRatio < 1
        ? discountRatio
        : 0;

    const returnedGrossBeforeDiscount =
      safeDiscountRatio < 1
        ? round2(taxableReturned / (1 - safeDiscountRatio))
        : round2(taxableReturned);

    return {
      returnedGrossBeforeDiscount,
      discountReversal: round2(returnedGrossBeforeDiscount - taxableReturned)
    };
  };

  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);

  const originalSaleId = objectIdOrUndefined(
    payload.originalSaleId ||
    payload.original_sale_id ||
    payload.saleId ||
    payload.sale_id
  );

  const originalSale = originalSaleId ? await Sale.findById(originalSaleId) : null;

  const admissionId = objectIdOrUndefined(
    payload.admission_id ||
    payload.admissionId ||
    originalSale?.admission_id
  );

  const patientId = objectIdOrUndefined(
    payload.patient_id ||
    payload.patientId ||
    originalSale?.patient_id
  );

  if (!originalSale) {
    console.error('Original sale not found for ID:', originalSaleId);
    throw new Error('Original sale not found');
  }

  console.log('Original sale found:', originalSale.sale_number);

  const deferValidation = await validateDeferredPaymentReturn(originalSaleId);
  if (deferValidation.isDeferred) {
    console.log('Processing return for deferred payment:', deferValidation.message);
  }

  const getOriginalSaleItem = (retItem) => {
    if (!originalSale?.items) return null;

    if (retItem.saleItemId) {
      const byId = originalSale.items.id?.(retItem.saleItemId);
      if (byId) return byId;
    }

    return originalSale.items.find(i =>
      idsEqual(i.medicine_id, retItem.medicineId) &&
      (!retItem.batchId || idsEqual(i.batch_id, retItem.batchId))
    );
  };

  const items = (payload.items || []).map(raw => {
    const grossAmount = round2(raw.grossAmount);
    const discountReversal = round2(raw.discountReversal || 0);
    const taxableAmount = round2(raw.taxableAmount || (grossAmount - discountReversal));
    const taxRate = Number(raw.taxRate || 0);
    const taxAmount = round2(taxableAmount * taxRate / 100);
    const refundAmount = round2(taxableAmount + taxAmount);

    return {
      saleItemId: raw.saleItemId,
      medicineId: raw.medicineId,
      batchId: raw.batchId,
      medicineName: raw.medicineName,
      returnedQtyBaseUnits: Number(raw.returnedQtyBaseUnits || 0),
      baseUnit: raw.baseUnit,
      unitsPerPack: Number(raw.unitsPerPack || 1),
      ratePerBaseUnit: round2(raw.ratePerBaseUnit),
      grossAmount: grossAmount,
      discountReversal: discountReversal,
      taxableAmount: taxableAmount,
      taxRate: taxRate,
      taxAmount: taxAmount,
      refundAmount: refundAmount,
      purchaseRatePerBaseUnit: round2(raw.purchaseRatePerBaseUnit || 0),
      condition: raw.condition || 'SEALED_USABLE',
      restock: raw.restock !== false
    };
  });

  if (!items.length) {
    throw new Error('No return items provided');
  }

  console.log('Processed return items:', JSON.stringify(items, null, 2));

  const pharmacyReturn = await PharmacyReturn.create({
    hospitalId,
    pharmacyId,
    originalSaleId,
    originalInvoiceId: objectIdOrUndefined(
      payload.originalInvoiceId ||
      payload.original_invoice_id ||
      originalSale?.invoice_id
    ),
    originalSaleNumber: originalSale?.sale_number,
    patientId,
    admissionId,
    returnType:
      payload.returnType ||
      payload.return_type ||
      (admissionId ? 'IPD_UNUSED_MEDICINE' : patientId ? 'OPD_RETURN' : 'WALKIN_RETURN'),
    items,
    totalRefundAmount: sumMoney(items, item => item.refundAmount),
    refundMode: payload.refundMode || payload.refund_mode || 'PharmacyAdvance',
    refundReference: payload.refundReference || payload.refund_reference,
    status: payload.status || 'Completed',
    notes: payload.notes,
    createdBy
  });

  console.log('Pharmacy return created:', pharmacyReturn.returnNumber);

  await restockAndCreateLedger({
    items: pharmacyReturn.items,
    hospitalId,
    pharmacyId,
    returnId: pharmacyReturn._id,
    createdBy
  });

  if (admissionId && patientId) {
    for (const item of pharmacyReturn.items) {
      await IPDPatientMedicineStock.findOneAndUpdate(
        {
          admissionId,
          patientId,
          medicineId: item.medicineId,
          ...(item.batchId ? { batchId: item.batchId } : {})
        },
        {
          $inc: {
            returnedQtyBaseUnits: Number(item.returnedQtyBaseUnits || 0),
            currentBalanceBaseUnits: -Number(item.returnedQtyBaseUnits || 0)
          },
          $set: {
            lastReturnedAt: new Date()
          }
        },
        {
          new: true,
          upsert: true
        }
      );
    }
  }

  const refundAmount = round2(pharmacyReturn.totalRefundAmount);
  const refundMode = pharmacyReturn.refundMode;

  console.log(`Refund amount: ${refundAmount}, Refund mode: ${refundMode}`);

  for (const retItem of pharmacyReturn.items) {
    const saleItem = getOriginalSaleItem(retItem);

    if (saleItem) {
      saleItem.returned_quantity_base_units =
        Number(saleItem.returned_quantity_base_units || 0) +
        Number(retItem.returnedQtyBaseUnits || 0);

      saleItem.returned_amount =
        round2(Number(saleItem.returned_amount || 0) + Number(retItem.refundAmount || 0));
    }
  }

  if (originalSale.payment_deferred) {
    console.log('Handling return for deferred payment sale...');
    await handleDeferredPaymentReturn(originalSale, refundAmount, refundMode, pharmacyReturn._id, createdBy);
  } else {
    originalSale.return_refs = originalSale.return_refs || [];
    originalSale.return_refs.push({
      return_id: pharmacyReturn._id,
      return_number: pharmacyReturn.returnNumber,
      amount: refundAmount,
      returned_at: new Date()
    });

    originalSale.return_amount = round2(
      Number(originalSale.return_amount || 0) + refundAmount
    );

    originalSale.net_amount_after_returns = clampMoney(
      Number(originalSale.total_amount || 0) - Number(originalSale.return_amount || 0)
    );

    originalSale.balance_due = clampMoney(
      Number(originalSale.balance_due || 0) - refundAmount
    );

    originalSale.status =
      Number(originalSale.return_amount || 0) >= Number(originalSale.total_amount || 0)
        ? 'Refunded'
        : 'PartiallyReturned';

    await originalSale.save();
  }
  console.log('Original sale updated');

  let associatedBill = await Bill.findOne({
    $or: [
      { sale_id: originalSaleId },
      { invoice_id: originalSale?.invoice_id },
      { _id: originalSale?.bill_id }
    ]
  });

  let updatedBillDataForResponse = null;
  let updatedItemsForResponse = [];

  if (associatedBill) {
    console.log('Found associated bill:', associatedBill._id);

    const totalReturnedAmount = sumMoney(
      pharmacyReturn.items,
      item => item.refundAmount
    );

    const totalReturnedTax = sumMoney(
      pharmacyReturn.items,
      item => item.taxAmount
    );

    const totalReturnedSubtotal = round2(totalReturnedAmount - totalReturnedTax);

    const totalSuppliedDiscountReversal = sumMoney(
      pharmacyReturn.items,
      item => item.discountReversal
    );

    console.log(`Total returned amount: ${totalReturnedAmount}`);
    console.log(`Total returned tax: ${totalReturnedTax}`);
    console.log(`Total returned taxable subtotal: ${totalReturnedSubtotal}`);
    console.log(`Total supplied discount reversal: ${totalSuppliedDiscountReversal}`);

    for (const retItem of pharmacyReturn.items) {
      const existingBillReturnItem = associatedBill.items?.find(item =>
        item.item_type === 'Medicine Return' &&
        idsEqual(item.medicine_id, retItem.medicineId) &&
        idsEqual(item.batch_id, retItem.batchId)
      );

      const originalSaleItem = getOriginalSaleItem(retItem);
      const returnedQty = Number(retItem.returnedQtyBaseUnits || 0);
      const returnedAmount = round2(retItem.refundAmount);
      const returnedTax = round2(retItem.taxAmount);

      if (existingBillReturnItem) {
        const currentReturnAmount = Math.abs(Number(existingBillReturnItem.amount || 0));
        const currentReturnTax = Math.abs(Number(existingBillReturnItem.tax_amount || 0));
        const currentQty = Number(existingBillReturnItem.quantity || 0);
        const currentQtyBase = Number(existingBillReturnItem.quantity_base_units || currentQty || 0);

        const newQty = currentQty + returnedQty;
        const newQtyBase = currentQtyBase + returnedQty;
        const newTotalRefund = round2(currentReturnAmount + returnedAmount);
        const newTotalTax = round2(currentReturnTax + returnedTax);

        existingBillReturnItem.amount = -newTotalRefund;
        existingBillReturnItem.tax_amount = -newTotalTax;
        existingBillReturnItem.quantity = newQty;
        existingBillReturnItem.quantity_base_units = newQtyBase;
        existingBillReturnItem.unit_price = round2(newTotalRefund / Math.max(newQtyBase, 1));
        existingBillReturnItem.description = `RETURN: ${retItem.medicineName} (Multiple Returns)`;
        existingBillReturnItem.return_reference = pharmacyReturn.returnNumber;
      } else {
        associatedBill.items.push({
          description: `RETURN: ${retItem.medicineName} (Return #${pharmacyReturn.returnNumber})`,
          amount: -returnedAmount,
          quantity: returnedQty,
          item_type: 'Medicine Return',
          medicine_id: retItem.medicineId,
          batch_id: retItem.batchId,
          medicine_name: retItem.medicineName,
          batch_number: originalSaleItem?.batch_number || retItem.batchNumber || retItem.batch_number || 'N/A',
          expiry_date: originalSaleItem?.expiry_date || retItem.expiryDate || retItem.expiry_date || null,
          base_unit: retItem.baseUnit,
          quantity_base_units: returnedQty,
          unit_price: round2(retItem.ratePerBaseUnit),
          tax_rate: Number(retItem.taxRate || 0),
          tax_amount: -returnedTax,
          discount_amount: 0,
          return_reference: pharmacyReturn.returnNumber
        });
      }
    }

    if (associatedBill.markModified) {
      associatedBill.markModified('items');
    }

    const currentBillSubtotal = Number(associatedBill.subtotal || 0);
    const currentBillTax = Number(associatedBill.tax_amount || 0);
    const currentBillTotal = Number(associatedBill.total_amount || 0);

    let currentBillDiscount = Number(
      associatedBill.discount_amount ||
      associatedBill.discount ||
      0
    );

    if (
      currentBillDiscount <= 0 &&
      currentBillSubtotal + currentBillTax > currentBillTotal
    ) {
      currentBillDiscount = round2(currentBillSubtotal + currentBillTax - currentBillTotal);
    }

    const billReturnAccounting = calculateReturnAccounting({
      currentSubtotal: currentBillSubtotal,
      currentDiscount: currentBillDiscount,
      returnedTaxable: totalReturnedSubtotal,
      suppliedDiscountReversal: totalSuppliedDiscountReversal
    });

    const newBillSubtotal = clampMoney(
      currentBillSubtotal - billReturnAccounting.returnedGrossBeforeDiscount
    );

    const newBillDiscount = clampMoney(
      currentBillDiscount - billReturnAccounting.discountReversal
    );

    const newBillTax = clampMoney(currentBillTax - totalReturnedTax);

    const newBillTotal = clampMoney(
      newBillSubtotal - newBillDiscount + newBillTax
    );

    associatedBill.subtotal = newBillSubtotal;
    associatedBill.tax_amount = newBillTax;
    associatedBill.total_amount = newBillTotal;

    if (associatedBill.discount_amount !== undefined) {
      associatedBill.discount_amount = newBillDiscount;
    }

    if (associatedBill.discount !== undefined) {
      associatedBill.discount = newBillDiscount;
    }

    if (cashRefundModes.includes(refundMode)) {
      associatedBill.paid_amount = clampMoney(
        Number(associatedBill.paid_amount || 0) - totalReturnedAmount
      );
    } else if (refundMode === 'PharmacyAdvance') {
      associatedBill.pharmacy_advance_used = clampMoney(
        Number(associatedBill.pharmacy_advance_used || 0) - totalReturnedAmount
      );
    } else if (refundMode === 'IPDAdvance') {
      associatedBill.ipd_advance_used = clampMoney(
        Number(associatedBill.ipd_advance_used || 0) - totalReturnedAmount
      );
    }

    if (Number(associatedBill.paid_amount || 0) > Number(associatedBill.total_amount || 0)) {
      associatedBill.paid_amount = associatedBill.total_amount;
    }

    associatedBill.balance_due = clampMoney(
      Number(associatedBill.total_amount || 0) - Number(associatedBill.paid_amount || 0)
    );

    if (associatedBill.total_amount <= 0 || associatedBill.balance_due <= 0) {
      associatedBill.status = 'Paid';
    } else if (associatedBill.paid_amount > 0) {
      associatedBill.status = 'Partially Paid';
    } else {
      associatedBill.status = 'Pending';
    }

    associatedBill.notes = associatedBill.notes
      ? `${associatedBill.notes}\nReturn ${pharmacyReturn.returnNumber}: -₹${totalReturnedAmount.toFixed(2)}`
      : `Return ${pharmacyReturn.returnNumber}: -₹${totalReturnedAmount.toFixed(2)}`;

    associatedBill.return_refs = associatedBill.return_refs || [];
    associatedBill.return_refs.push({
      return_id: pharmacyReturn._id,
      return_number: pharmacyReturn.returnNumber,
      amount: totalReturnedAmount,
      taxable_amount: totalReturnedSubtotal,
      tax_amount: totalReturnedTax,
      gross_before_discount: billReturnAccounting.returnedGrossBeforeDiscount,
      discount_reversal: billReturnAccounting.discountReversal,
      returned_at: new Date()
    });

    await associatedBill.save();
    console.log('Bill saved successfully');

    const invoiceId = associatedBill.invoice_id || originalSale?.invoice_id;
    const associatedInvoice = invoiceId ? await Invoice.findById(invoiceId) : null;

    if (associatedInvoice) {
      console.log('Found associated invoice:', associatedInvoice._id);

      for (const retItem of pharmacyReturn.items) {
        const existingInvoiceReturnItem = associatedInvoice.medicine_items?.find(item =>
          item.item_type === 'Medicine Return' &&
          idsEqual(item.medicine_id, retItem.medicineId) &&
          idsEqual(item.batch_id, retItem.batchId)
        );

        const originalSaleItem = getOriginalSaleItem(retItem);
        const returnedQty = Number(retItem.returnedQtyBaseUnits || 0);
        const returnedAmount = round2(retItem.refundAmount);
        const returnedTax = round2(retItem.taxAmount);

        if (existingInvoiceReturnItem) {
          const currentReturnAmount = Math.abs(Number(existingInvoiceReturnItem.total_price || 0));
          const currentReturnTax = Math.abs(Number(existingInvoiceReturnItem.tax_amount || 0));
          const currentQty = Number(existingInvoiceReturnItem.quantity || 0);
          const currentQtyBase = Number(existingInvoiceReturnItem.quantity_base_units || currentQty || 0);

          const newQty = currentQty + returnedQty;
          const newQtyBase = currentQtyBase + returnedQty;
          const newTotalRefund = round2(currentReturnAmount + returnedAmount);
          const newTotalTax = round2(currentReturnTax + returnedTax);

          existingInvoiceReturnItem.description = `RETURN: ${retItem.medicineName} (Multiple Returns)`;
          existingInvoiceReturnItem.medicine_name = retItem.medicineName;
          existingInvoiceReturnItem.quantity = newQty;
          existingInvoiceReturnItem.quantity_base_units = newQtyBase;
          existingInvoiceReturnItem.base_unit = retItem.baseUnit || existingInvoiceReturnItem.base_unit;
          existingInvoiceReturnItem.unit_price = round2(newTotalRefund / Math.max(newQtyBase, 1));
          existingInvoiceReturnItem.total_price = -newTotalRefund;
          existingInvoiceReturnItem.tax_amount = -newTotalTax;
          existingInvoiceReturnItem.tax_rate = Number(retItem.taxRate || 0);
          existingInvoiceReturnItem.item_type = 'Medicine Return';
          existingInvoiceReturnItem.is_return = true;
          existingInvoiceReturnItem.return_reference = pharmacyReturn.returnNumber;
          existingInvoiceReturnItem.return_id = pharmacyReturn._id;
          existingInvoiceReturnItem.is_dispensed = false;
        } else {
          associatedInvoice.medicine_items.push({
            medicine_id: retItem.medicineId,
            batch_id: retItem.batchId,
            medicine_name: retItem.medicineName,
            description: `RETURN: ${retItem.medicineName} (Return #${pharmacyReturn.returnNumber})`,
            batch_number: originalSaleItem?.batch_number || retItem.batchNumber || retItem.batch_number || 'N/A',
            expiry_date: originalSaleItem?.expiry_date || retItem.expiryDate || retItem.expiry_date || null,
            quantity: returnedQty,
            quantity_base_units: returnedQty,
            base_unit: retItem.baseUnit || 'unit',
            unit_price: round2(retItem.ratePerBaseUnit),
            total_price: -returnedAmount,
            tax_rate: Number(retItem.taxRate || 0),
            tax_amount: -returnedTax,
            prescription_required: false,
            is_dispensed: false,
            item_type: 'Medicine Return',
            is_return: true,
            return_reference: pharmacyReturn.returnNumber,
            return_id: pharmacyReturn._id
          });
        }
      }

      if (associatedInvoice.markModified) {
        associatedInvoice.markModified('medicine_items');
      }

      const currentInvoiceSubtotal = Number(associatedInvoice.subtotal || 0);
      const currentInvoiceDiscount = Number(associatedInvoice.discount || 0);
      const currentInvoiceTax = Number(associatedInvoice.tax || 0);

      let newInvoiceSubtotal = clampMoney(currentInvoiceSubtotal - totalReturnedSubtotal);
      let newInvoiceDiscount = clampMoney(currentInvoiceDiscount - totalSuppliedDiscountReversal);
      let newInvoiceTax = clampMoney(currentInvoiceTax - totalReturnedTax);

      if (newInvoiceSubtotal <= 0) {
        newInvoiceSubtotal = 0;
        newInvoiceDiscount = 0;
      }

      if (newInvoiceDiscount > newInvoiceSubtotal) {
        newInvoiceDiscount = newInvoiceSubtotal;
      }

      let newInvoiceTotal = clampMoney(newInvoiceSubtotal - newInvoiceDiscount + newInvoiceTax);
      if (newInvoiceTotal < 0) newInvoiceTotal = 0;

      let newAmountPaid = Number(associatedInvoice.amount_paid || 0);
      if (cashRefundModes.includes(refundMode)) {
        newAmountPaid = clampMoney(newAmountPaid - totalReturnedAmount);
      }

      if (newAmountPaid > newInvoiceTotal) {
        newAmountPaid = newInvoiceTotal;
      }

      const newBalanceDue = clampMoney(newInvoiceTotal - newAmountPaid);

      associatedInvoice.subtotal = newInvoiceSubtotal;
      associatedInvoice.discount = newInvoiceDiscount;
      associatedInvoice.tax = newInvoiceTax;
      associatedInvoice.total = newInvoiceTotal;
      associatedInvoice.amount_paid = newAmountPaid;
      associatedInvoice.balance_due = newBalanceDue;

      if (newInvoiceTotal <= 0) {
        associatedInvoice.status = 'Fully Returned';
      } else if (newBalanceDue <= 0) {
        associatedInvoice.status = 'Paid';
      } else if (newAmountPaid > 0) {
        associatedInvoice.status = 'Partial';
      } else {
        associatedInvoice.status = 'Pending';
      }

      associatedInvoice.return_refs = associatedInvoice.return_refs || [];
      associatedInvoice.return_refs.push({
        return_id: pharmacyReturn._id,
        return_number: pharmacyReturn.returnNumber,
        amount: totalReturnedAmount,
        taxable_amount: totalReturnedSubtotal,
        tax_amount: totalReturnedTax,
        gross_before_discount: totalReturnedSubtotal,
        discount_reversal: totalSuppliedDiscountReversal,
        returned_at: new Date()
      });

      associatedInvoice.notes = associatedInvoice.notes
        ? `${associatedInvoice.notes}\nReturn ${pharmacyReturn.returnNumber}: -₹${totalReturnedAmount.toFixed(2)}`
        : `Return ${pharmacyReturn.returnNumber}: -₹${totalReturnedAmount.toFixed(2)}`;

      if (associatedInvoice.subtotal < associatedInvoice.discount) {
        associatedInvoice.discount = associatedInvoice.subtotal;
      }

      const calculatedTotal = associatedInvoice.subtotal - associatedInvoice.discount + associatedInvoice.tax;
      if (Math.abs(associatedInvoice.total - calculatedTotal) > 0.01) {
        associatedInvoice.total = calculatedTotal;
      }

      if (associatedInvoice.amount_paid > associatedInvoice.total) {
        associatedInvoice.amount_paid = associatedInvoice.total;
      }

      associatedInvoice.balance_due = associatedInvoice.total - associatedInvoice.amount_paid;

      await associatedInvoice.save();
      console.log('Invoice saved successfully');
    } else {
      console.log('No associated invoice found');
    }

    const subtotal = round2(associatedBill.subtotal || 0);
    const discount = round2(associatedBill.discount_amount || associatedBill.discount || 0);
    const taxableAmount = round2(Math.max(0, subtotal - discount));
    const tax = round2(associatedBill.tax_amount || 0);
    const netTotal = round2(taxableAmount + tax);
    const amountPaid = round2(associatedBill.paid_amount || 0);
    const balanceDue = round2(Math.max(0, netTotal - amountPaid));

    updatedBillDataForResponse = {
      billNumber: associatedBill.bill_number || associatedBill.billNumber || originalSale.sale_number,
      invoiceNumber: associatedBill.invoice_number,
      subtotal,
      discount,
      taxableAmount,
      tax,
      netTotal,
      amountPaid,
      balanceDue,
      returnAmount: totalReturnedAmount,
      refundMode,
      returnNumber: pharmacyReturn.returnNumber
    };

    updatedItemsForResponse = (associatedBill.items || []).map(item => ({
      description: item.description,
      medicine_name: item.medicine_name || item.description,
      composition: item.composition || '',
      quantity: item.quantity_base_units || item.quantity || 1,
      base_unit: item.base_unit || 'unit',
      unit_price: round2(item.unit_price || 0),
      total: round2(item.amount || item.total_price || 0),
      batch_number: item.batch_number || 'N/A',
      expiry_date: item.expiry_date || null,
      tax_rate: Number(item.tax_rate || 0),
      tax_amount: round2(item.tax_amount || 0),
      discount_amount: round2(item.discount_amount || 0),
      isReturned: item.item_type === 'Medicine Return',
      item_type: item.item_type
    }));
  } else {
    console.log('No associated bill found');
  }

  if (
    refundAmount > 0 &&
    admissionId &&
    patientId &&
    ['IPDAdvance', 'PharmacyAdvance'].includes(refundMode) &&
    !originalSale.payment_deferred
  ) {
    await createAdvanceLedgerEntry({
      hospitalId,
      patientId,
      admissionId,
      walletType: refundMode === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED',
      transactionType: 'PHARMACY_RETURN_CREDIT',
      direction: 'CREDIT',
      amount: refundAmount,
      paymentMethod: refundMode,
      referenceNumber: pharmacyReturn.returnNumber,
      sourceModule: 'Pharmacy',
      sourceId: pharmacyReturn._id,
      notes: `Medicine return ${pharmacyReturn.returnNumber}`,
      createdBy
    });

    console.log('Advance ledger entry created');
  }

  await PharmacyLedgerEntry.create({
    hospitalId,
    pharmacyId,
    entryType: cashRefundModes.includes(refundMode) ? 'REFUND' : 'RETURN',
    direction: cashRefundModes.includes(refundMode) ? 'OUT' : 'NON_CASH',
    amount: refundAmount,
    paymentMethod:
      refundMode === 'IPDAdvance'
        ? 'IPDAdvance'
        : refundMode === 'PharmacyAdvance'
          ? 'PharmacyAdvance'
          : refundMode === 'NoRefund'
            ? 'Adjustment'
            : refundMode,
    patientId,
    admissionId,
    saleId: originalSale?._id,
    returnId: pharmacyReturn._id,
    invoiceId: originalSale?.invoice_id,
    notes: `Return ${pharmacyReturn.returnNumber}${originalSale ? ` against ${originalSale.sale_number}` : ''}`,
    createdBy
  });

  console.log('Pharmacy ledger entry created');

  const balances = await getPatientPharmacySummary({ patientId, admissionId });

  pharmacyReturn.patientOutstandingAfter = balances.outstanding;
  pharmacyReturn.pharmacyAdvanceAfter = balances.pharmacyAdvance;

  await pharmacyReturn.save();

  const responseReturn = pharmacyReturn.toObject ? pharmacyReturn.toObject() : pharmacyReturn;

  responseReturn.updatedBill = updatedBillDataForResponse;
  responseReturn.updatedItems = updatedItemsForResponse;
  responseReturn.originalSaleDate = originalSale.sale_date;
  responseReturn.originalPaymentMethod = originalSale.payment_method;
  responseReturn.originalTotal = round2(originalSale.total_amount || 0);

  console.log('========== CREATE RETURN END ==========');

  return responseReturn;
}

async function createOutstandingSettlement(payload, req = {}) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId);
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId);
  if (!patientId && !admissionId) throw new Error('patientId or admissionId is required for settlement.');
  const payments = normalizePayments({ total: payload.amount, payment_method: payload.payment_method || payload.paymentMethod, payments: payload.payments });
  const amount = normalizeMoney(payments.reduce((sum, p) => sum + p.amount, 0));
  const fakeSale = { _id: undefined, sale_number: payload.referenceNumber || 'SETTLEMENT', patient_id: patientId, admission_id: admissionId };
  for (const p of payments) await consumeAdvancePayment({ p, sale: fakeSale, hospitalId, patientId, admissionId, createdBy });
  const allocation = await allocatePaymentToOutstanding({ patientId, admissionId, hospitalId, pharmacyId, createdBy, sale: fakeSale, amount, payments });
  const extra = normalizeMoney(amount - allocation.allocated);
  if (extra > 0) {
    await createAdvanceLedgerEntry({
      hospitalId,
      patientId,
      admissionId,
      walletType: 'PHARMACY_IPD',
      transactionType: 'PHARMACY_OVERPAYMENT_CREDIT',
      direction: 'CREDIT',
      amount: extra,
      paymentMethod: payments[0]?.method || 'Cash',
      referenceNumber: payload.referenceNumber,
      sourceModule: 'Pharmacy',
      notes: 'Extra settlement amount credited to pharmacy advance',
      createdBy
    });
  }
  return { allocation, extraAdvance: extra, balances: await getPatientPharmacySummary({ patientId, admissionId }) };
}

// ========== Bulk Settle Deferred Payments ==========
async function bulkSettleDeferredPayments(payload, req = {}) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id) || (await (async () => {
    const Pharmacy = mongoose.model('Pharmacy');
    const pharmacy = await Pharmacy.findOne({ status: 'Active' }).select('_id');
    return pharmacy?._id;
  })());
  const createdBy = getCreatedBy(req);
  const admissionId = objectIdOrUndefined(payload.admissionId);
  const patientId = objectIdOrUndefined(payload.patientId);

  if (!admissionId && !patientId) {
    throw new Error('admissionId or patientId is required');
  }

  const {
    saleIds,
    discount = 0,
    discountType = 'percentage',
    discountBase = 'due',
    payments = [],
    notes = '',
    settleAll = false
  } = payload;

  const query = {
    include_in_discharge_clearance: true,
    status: { $ne: 'Cancelled' }
  };

  if (admissionId) query.admission_id = admissionId;
  if (patientId) query.patient_id = patientId;
  if (!settleAll && saleIds && saleIds.length > 0) {
    query._id = { $in: saleIds.map(id => objectIdOrUndefined(id)) };
  }

  const deferredSales = await Sale.find(query)
    .sort({ sale_date: 1 })
    .lean();

  if (deferredSales.length === 0) {
    return { settled: [], totalAmount: 0, message: 'No pending deferred payments found' };
  }

  let totalDue = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
  totalDue = normalizeMoney(totalDue);

  let totalBillAmount = deferredSales.reduce((sum, sale) => sum + (sale.total_amount || sale.gross_amount || sale.balance_due || 0), 0);
  totalBillAmount = normalizeMoney(totalBillAmount);

  let discountAmount = 0;
  if (discountType === 'percentage') {
    const baseAmount = discountBase === 'total' ? totalBillAmount : totalDue;
    discountAmount = normalizeMoney(baseAmount * (discount / 100));
  } else {
    discountAmount = normalizeMoney(discount);
  }

  const excessDiscount = Math.max(0, normalizeMoney(discountAmount - totalDue));
  const amountAfterDiscount = normalizeMoney(Math.max(0, totalDue - discountAmount));
  const totalCollected = normalizeMoney(payments.reduce((sum, p) => sum + (p.amount || 0), 0));

  if (amountAfterDiscount >= 0) {
    if (Math.abs(totalCollected - amountAfterDiscount) > 0.01) {
      throw new Error(`Collected amount (${totalCollected}) does not match amount after discount (${amountAfterDiscount})`);
    }
  } else {
    if (totalCollected > 0) {
      throw new Error(`Cannot collect payment when discount exceeds due amount`);
    }
  }

  const paymentEntries = [];
  let remainingToAllocate = amountAfterDiscount > 0 ? amountAfterDiscount : 0;

  for (const payment of payments) {
    if (remainingToAllocate <= 0) break;
    const amount = normalizeMoney(Math.min(payment.amount, remainingToAllocate));
    if (amount <= 0) continue;

    paymentEntries.push({
      method: payment.method,
      amount: amount,
      reference: payment.reference || null,
      walletType: payment.walletType || (payment.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : payment.method === 'IPDAdvance' ? 'IPD_SHARED' : null)
    });
    remainingToAllocate = normalizeMoney(remainingToAllocate - amount);
  }

  for (const p of paymentEntries) {
    if (['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) {
      if (!admissionId || !patientId) {
        throw new Error(`${p.method} can only be used for admitted IPD patients.`);
      }
      const walletType = p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED');
      const balance = await getAdvanceBalance({ admissionId, patientId, walletType });
      if (balance + 0.01 < p.amount) {
        throw new Error(`Insufficient ${walletType} balance. Available ₹${balance}, needed ₹${p.amount}.`);
      }
    }
  }

  if (excessDiscount > 0) {
    const PatientAdvanceLedger = mongoose.model('PatientAdvanceLedger');
    await PatientAdvanceLedger.create({
      patientId,
      admissionId,
      walletType: 'PHARMACY_IPD',
      entryType: 'CREDIT',
      amount: excessDiscount,
      paymentMethod: 'Discount',
      sourceType: 'Sale',
      notes: `Excess discount from bulk settlement of pharmacy bills credited to advance.`,
      createdBy
    });
  }

  const results = [];
  let totalDiscountAllocated = 0;
  let totalPaid = 0;

  for (const sale of deferredSales) {
    const saleDue = sale.balance_due || 0;
    let saleDiscount = 0;
    if (totalDue > 0) {
      saleDiscount = normalizeMoney((saleDue / totalDue) * discountAmount);
    }

    const applicableSaleDiscount = Math.min(saleDiscount, saleDue);
    totalDiscountAllocated += applicableSaleDiscount;

    const saleAmountAfterDiscount = normalizeMoney(saleDue - applicableSaleDiscount);
    const salePaid = amountAfterDiscount > 0 ? normalizeMoney((saleAmountAfterDiscount / amountAfterDiscount) * totalCollected) : 0;
    totalPaid += salePaid;

    const saleDiscountRatio = saleDue > 0 ? applicableSaleDiscount / saleDue : 0;

    const updatedSale = await Sale.findById(sale._id);
    if (!updatedSale) continue;

    const oldPaidAmount = updatedSale.amount_paid || 0;
    updatedSale.amount_paid = normalizeMoney(oldPaidAmount + salePaid);
    updatedSale.balance_due = normalizeMoney(Math.max(0, saleAmountAfterDiscount - salePaid));
    updatedSale.status = updatedSale.balance_due <= 0 ? 'Completed' : 'Partially Paid';
    updatedSale.payment_deferred = updatedSale.balance_due > 0;

    if (applicableSaleDiscount > 0) {
      updatedSale.discount_amount = normalizeMoney((updatedSale.discount_amount || 0) + applicableSaleDiscount);
      updatedSale.discount_reason = updatedSale.discount_reason
        ? `${updatedSale.discount_reason}; Bulk settlement discount ₹${applicableSaleDiscount}`
        : `Bulk settlement discount ₹${applicableSaleDiscount}`;
    }

    updatedSale.payments = updatedSale.payments || [];

    const salePaymentEntries = allocatePaymentsForAmount(paymentEntries, salePaid);
    for (const p of salePaymentEntries) {
      updatedSale.payments.push({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        date: new Date(),
        collected_by: createdBy
      });
    }

    updatedSale.settled_at = updatedSale.balance_due <= 0 ? new Date() : updatedSale.settled_at;
    await updatedSale.save();

    for (const p of salePaymentEntries) {
      if (['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) {
        await consumeAdvancePayment({
          p,
          sale: updatedSale,
          hospitalId,
          patientId: updatedSale.patient_id,
          admissionId: updatedSale.admission_id,
          createdBy
        });
      }
    }

    await createPharmacyLedgerForPayments({
      payments: salePaymentEntries,
      sale: updatedSale,
      hospitalId,
      pharmacyId,
      createdBy,
      entryType: 'OUTSTANDING_PAYMENT'
    });

    if (updatedSale.invoice_id) {
      const invoice = await Invoice.findById(updatedSale.invoice_id);
      if (invoice) {
        console.log(`========== PROCESSING INVOICE: ${invoice.invoice_number} ==========`);
        console.log('Invoice BEFORE update:', {
          subtotal: invoice.subtotal,
          discount: invoice.discount,
          tax: invoice.tax,
          total: invoice.total,
          amount_paid: invoice.amount_paid,
          balance_due: invoice.balance_due
        });

        const originalSubtotal = invoice.subtotal;
        const totalDiscount = normalizeMoney((invoice.discount || 0) + saleDiscount);
        const newTax = normalizeMoney(invoice.tax * (1 - saleDiscountRatio));
        const newTotal = normalizeMoney(originalSubtotal - totalDiscount + newTax);
        const newAmountPaid = normalizeMoney((invoice.amount_paid || 0) + salePaid);
        const newBalanceDue = normalizeMoney(newTotal - newAmountPaid);

        invoice.discount = totalDiscount;
        invoice.tax = newTax;
        invoice.total = newTotal;
        invoice.amount_paid = newAmountPaid;
        invoice.balance_due = newBalanceDue;

        if (invoice.amount_paid > invoice.total) {
          invoice.amount_paid = invoice.total;
          invoice.balance_due = 0;
        }

        if (invoice.balance_due < 0) {
          invoice.balance_due = 0;
        }

        invoice.medicine_items = invoice.medicine_items.map(item => {
          const originalTotal = item.total_price;
          const itemDiscount = normalizeMoney(originalTotal * saleDiscountRatio);
          const newItemTotal = normalizeMoney(originalTotal - itemDiscount);
          const taxableAmount = normalizeMoney(item.taxable_amount - itemDiscount);

          let newTaxAmount = item.tax_amount;
          if (item.tax_rate > 0 && taxableAmount > 0) {
            newTaxAmount = normalizeMoney(taxableAmount * item.tax_rate / 100);
          }

          return {
            ...item.toObject(),
            discount_amount: (item.discount_amount || 0) + itemDiscount,
            taxable_amount: taxableAmount,
            total_price: newItemTotal,
            tax_amount: newTaxAmount
          };
        });

        if (invoice.balance_due <= 0) {
          invoice.status = 'Paid';
        } else if (invoice.amount_paid > 0) {
          invoice.status = 'Partial';
        } else {
          invoice.status = 'Pending';
        }

        for (const p of salePaymentEntries) {
          invoice.payment_history = invoice.payment_history || [];
          invoice.payment_history.push({
            amount: p.amount,
            method: p.method,
            reference: p.reference,
            date: new Date(),
            status: 'Completed',
            collected_by: createdBy
          });
        }

        await invoice.save();
        console.log(`✅ Updated invoice ${invoice.invoice_number}`);
      }
    }

    let bill = null;

    if (sale.bill_id) {
      bill = await Bill.findById(sale.bill_id);
    }
    if (!bill && updatedSale._id) {
      bill = await Bill.findOne({ sale_id: updatedSale._id });
    }
    if (!bill && updatedSale.invoice_id) {
      bill = await Bill.findOne({ invoice_id: updatedSale.invoice_id });
    }

    if (bill) {
      console.log(`========== PROCESSING BILL: ${bill._id} ==========`);

      const originalSubtotal = bill.subtotal;
      const totalDiscount = normalizeMoney((bill.discount || 0) + saleDiscount);
      const newTax = normalizeMoney(bill.tax_amount * (1 - saleDiscountRatio));
      const newTotal = normalizeMoney(originalSubtotal - totalDiscount + newTax);
      const newPaidAmount = normalizeMoney((bill.paid_amount || 0) + salePaid);
      const newBalanceDue = normalizeMoney(newTotal - newPaidAmount);

      bill.discount = totalDiscount;
      bill.discount_amount = totalDiscount;
      bill.tax_amount = newTax;
      bill.total_amount = newTotal;
      bill.paid_amount = newPaidAmount;
      bill.balance_due = newBalanceDue;

      if (bill.paid_amount > bill.total_amount) {
        bill.paid_amount = bill.total_amount;
        bill.balance_due = 0;
      }

      if (bill.balance_due < 0) {
        bill.balance_due = 0;
      }

      bill.items = bill.items.map(item => {
        if (item.item_type === 'Medicine Return') return item;

        const originalAmount = Math.abs(item.amount);
        const itemDiscount = normalizeMoney(originalAmount * saleDiscountRatio);
        const newAmount = normalizeMoney(originalAmount - itemDiscount);
        const taxableAmount = normalizeMoney(item.taxable_amount - itemDiscount);

        let newTaxAmount = item.tax_amount;
        if (item.tax_rate > 0 && taxableAmount > 0) {
          newTaxAmount = normalizeMoney(taxableAmount * item.tax_rate / 100);
        }

        return {
          ...item.toObject(),
          amount: item.amount > 0 ? newAmount : -newAmount,
          discount_amount: (item.discount_amount || 0) + itemDiscount,
          taxable_amount: taxableAmount,
          tax_amount: item.amount > 0 ? newTaxAmount : -newTaxAmount
        };
      });

      if (bill.balance_due <= 0) {
        bill.status = 'Paid';
        bill.paid_at = new Date();
      } else if (bill.paid_amount > 0) {
        bill.status = 'Partially Paid';
      } else {
        bill.status = 'Pending';
      }

      for (const p of salePaymentEntries) {
        bill.payments = bill.payments || [];
        bill.payments.push({
          method: p.method,
          amount: p.amount,
          reference: p.reference,
          date: new Date()
        });
      }

      await bill.save();
      console.log(`✅ Updated bill ${bill._id}`);
    } else {
      console.log(`⚠️ No bill found for sale ${updatedSale.sale_number}`);
    }

    if (updatedSale.admission_id && updatedSale.patient_id && updatedSale.balance_due <= 0) {
      const ipdCharge = await IPDCharge.findOne({
        admissionId: updatedSale.admission_id,
        sourceId: updatedSale._id,
        sourceModule: 'Pharmacy'
      });
      if (ipdCharge && !ipdCharge.isBilled) {
        ipdCharge.isBilled = true;
        ipdCharge.billedAt = new Date();
        await ipdCharge.save();
      }
    }

    results.push({
      saleId: updatedSale._id,
      saleNumber: updatedSale.sale_number,
      paid: salePaid,
      discount: applicableSaleDiscount,
      balance_due: updatedSale.balance_due
    });
  }

  if (excessDiscount > 0 && patientId) {
    await createAdvanceLedgerEntry({
      hospitalId,
      patientId,
      admissionId,
      walletType: 'PHARMACY_IPD',
      transactionType: 'DISCOUNT_ADJUSTMENT',
      direction: 'CREDIT',
      amount: excessDiscount,
      paymentMethod: 'Discount',
      referenceNumber: 'BulkSettle',
      sourceModule: 'Pharmacy',
      notes: `Excess discount from bulk settlement credited to advance`,
      createdBy
    });

    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'DISCOUNT_ADJUSTMENT',
      direction: 'NON_CASH',
      amount: excessDiscount,
      paymentMethod: 'Discount',
      patientId,
      admissionId,
      notes: `Excess discount from bulk settlement credited to patient advance`,
      createdBy
    });

    const Patient = mongoose.model('Patient');
    await Patient.findByIdAndUpdate(patientId, {
      $inc: { pharmacy_advance_balance: excessDiscount }
    });
  }

  if (patientId) {
    const Patient = mongoose.model('Patient');
    await Patient.findByIdAndUpdate(patientId, {
      $inc: { pharmacy_outstanding_balance: -normalizeMoney(totalPaid + totalDiscountAllocated) },
      last_pharmacy_transaction: new Date()
    });
  }

  const finalBalances = await getPatientPharmacySummary({ patientId, admissionId });

  return {
    success: true,
    message: `${results.length} deferred payment(s) settled successfully`,
    summary: {
      totalDue,
      discountAmount: normalizeMoney(totalDiscountAllocated),
      amountAfterDiscount,
      totalPaid,
      discountPercentage: discount,
      discountType
    },
    settlements: results,
    paymentBreakdown: paymentEntries,
    balances: finalBalances
  };
}

// ========== Single Deferred Payment Settlement with Discount ==========
async function settleSingleDeferredPayment(saleId, payload, req = {}) {
  const {
    paymentMethod = 'Cash',
    reference,
    collected_by,
    discount = 0,
    discountType = 'percentage'
  } = payload;

  const sale = await Sale.findById(saleId);
  if (!sale) {
    throw new Error('Sale not found');
  }

  if (!sale.payment_deferred) {
    throw new Error('This sale is not a deferred payment');
  }

  if (sale.status === 'Completed') {
    throw new Error('Sale is already completed');
  }

  let amountToPay = sale.balance_due;
  let discountAmount = 0;

  if (discount > 0) {
    if (discountType === 'percentage') {
      discountAmount = normalizeMoney(amountToPay * (discount / 100));
    } else {
      discountAmount = normalizeMoney(Math.min(discount, amountToPay));
    }
    amountToPay = normalizeMoney(amountToPay - discountAmount);
  }

  const paidAmount = sale.amount_paid + amountToPay;
  const saleDue = sale.balance_due;
  const saleDiscountRatio = saleDue > 0 ? discountAmount / saleDue : 0;

  sale.amount_paid = paidAmount;
  sale.balance_due = 0;
  sale.status = 'Completed';
  sale.payment_method = paymentMethod;
  sale.payment_deferred = false;
  sale.settled_at = new Date();

  if (discountAmount > 0) {
    sale.discount_amount = normalizeMoney((sale.discount_amount || 0) + discountAmount);
    sale.discount_reason = sale.discount_reason
      ? `${sale.discount_reason}; Settlement discount ₹${discountAmount}`
      : `Settlement discount ₹${discountAmount}`;
  }

  sale.payments = sale.payments || [];
  sale.payments.push({
    method: paymentMethod,
    amount: amountToPay,
    reference: reference,
    date: new Date(),
    collected_by: collected_by
  });

  await sale.save();

  if (sale.invoice_id) {
    const invoice = await Invoice.findById(sale.invoice_id);
    if (invoice) {
      const originalSubtotal = invoice.subtotal;
      const totalDiscount = normalizeMoney((invoice.discount || 0) + discountAmount);
      const newTax = normalizeMoney(invoice.tax * (1 - saleDiscountRatio));
      const newTotal = normalizeMoney(originalSubtotal - totalDiscount + newTax);
      const newAmountPaid = normalizeMoney((invoice.amount_paid || 0) + amountToPay);
      const newBalanceDue = normalizeMoney(newTotal - newAmountPaid);

      invoice.discount = totalDiscount;
      invoice.tax = newTax;
      invoice.total = newTotal;
      invoice.amount_paid = newAmountPaid;
      invoice.balance_due = newBalanceDue;

      invoice.medicine_items = invoice.medicine_items.map(item => {
        const originalTotal = item.total_price;
        const itemDiscount = normalizeMoney(originalTotal * saleDiscountRatio);
        const newItemTotal = normalizeMoney(originalTotal - itemDiscount);
        const taxableAmount = normalizeMoney(item.taxable_amount - itemDiscount);

        let newTaxAmount = item.tax_amount;
        if (item.tax_rate > 0 && taxableAmount > 0) {
          newTaxAmount = normalizeMoney(taxableAmount * item.tax_rate / 100);
        }

        return {
          ...item.toObject(),
          discount_amount: (item.discount_amount || 0) + itemDiscount,
          taxable_amount: taxableAmount,
          total_price: newItemTotal,
          tax_amount: newTaxAmount
        };
      });

      if (newBalanceDue <= 0) {
        invoice.status = 'Paid';
      } else if (newAmountPaid > 0) {
        invoice.status = 'Partial';
      } else {
        invoice.status = 'Pending';
      }

      invoice.payment_history = invoice.payment_history || [];
      invoice.payment_history.push({
        amount: amountToPay,
        method: paymentMethod,
        reference: reference,
        date: new Date(),
        status: 'Completed',
        collected_by: collected_by
      });

      await invoice.save();
      console.log(`✅ Updated invoice ${invoice.invoice_number}: subtotal=${originalSubtotal}, discount=${totalDiscount}, tax=${newTax}, total=${newTotal}, paid=${newAmountPaid}`);
    }
  }

  if (sale.bill_id) {
    const bill = await Bill.findById(sale.bill_id);
    if (bill) {
      const originalSubtotal = bill.subtotal;
      const totalDiscount = normalizeMoney((bill.discount || 0) + discountAmount);
      const newTax = normalizeMoney(bill.tax_amount * (1 - saleDiscountRatio));
      const newTotal = normalizeMoney(originalSubtotal - totalDiscount + newTax);
      const newPaidAmount = normalizeMoney((bill.paid_amount || 0) + amountToPay);
      const newBalanceDue = normalizeMoney(newTotal - newPaidAmount);

      bill.discount = totalDiscount;
      bill.discount_amount = totalDiscount;
      bill.tax_amount = newTax;
      bill.total_amount = newTotal;
      bill.paid_amount = newPaidAmount;
      bill.balance_due = newBalanceDue;

      bill.items = bill.items.map(item => {
        if (item.item_type === 'Medicine Return') return item;

        const originalAmount = Math.abs(item.amount);
        const itemDiscount = normalizeMoney(originalAmount * saleDiscountRatio);
        const newAmount = normalizeMoney(originalAmount - itemDiscount);
        const taxableAmount = normalizeMoney(item.taxable_amount - itemDiscount);

        let newTaxAmount = item.tax_amount;
        if (item.tax_rate > 0 && taxableAmount > 0) {
          newTaxAmount = normalizeMoney(taxableAmount * item.tax_rate / 100);
        }

        return {
          ...item.toObject(),
          amount: item.amount > 0 ? newAmount : -newAmount,
          discount_amount: (item.discount_amount || 0) + itemDiscount,
          taxable_amount: taxableAmount,
          tax_amount: item.amount > 0 ? newTaxAmount : -newTaxAmount
        };
      });

      if (newBalanceDue <= 0) {
        bill.status = 'Paid';
        bill.paid_at = new Date();
      } else if (newPaidAmount > 0) {
        bill.status = 'Partially Paid';
      } else {
        bill.status = 'Pending';
      }

      bill.payments = bill.payments || [];
      bill.payments.push({
        method: paymentMethod,
        amount: amountToPay,
        reference: reference,
        date: new Date()
      });

      await bill.save();
      console.log(`✅ Updated bill ${bill._id}: subtotal=${originalSubtotal}, discount=${totalDiscount}, tax=${newTax}, total=${newTotal}, paid=${newPaidAmount}`);
    }
  }

  if (sale.patient_id) {
    await Patient.findByIdAndUpdate(sale.patient_id, {
      $inc: { pharmacy_outstanding_balance: -amountToPay }
    });
  }

  if (sale.admission_id && sale.patient_id) {
    const ipdCharge = await IPDCharge.findOne({
      admissionId: sale.admission_id,
      sourceId: sale._id,
      sourceModule: 'Pharmacy'
    });
    if (ipdCharge && !ipdCharge.isBilled) {
      ipdCharge.isBilled = true;
      ipdCharge.billedAt = new Date();
      await ipdCharge.save();
    }
  }

  const hospitalId = getHospitalId(req, sale.hospitalId);
  const pharmacyId = sale.pharmacy_id;
  const createdBy = collected_by || getCreatedBy(req);

  await PharmacyLedgerEntry.create({
    hospitalId,
    pharmacyId,
    entryType: 'OUTSTANDING_PAYMENT',
    direction: 'IN',
    amount: amountToPay,
    paymentMethod: paymentMethod,
    patientId: sale.patient_id,
    admissionId: sale.admission_id,
    saleId: sale._id,
    invoiceId: sale.invoice_id,
    notes: `Deferred payment settled via ${paymentMethod}. Discount: ₹${discountAmount}. Reference: ${reference || 'N/A'}`,
    createdBy
  });

  if (discountAmount > 0) {
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'DISCOUNT',
      direction: 'NON_CASH',
      amount: discountAmount,
      paymentMethod: 'Discount',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Settlement discount applied to deferred payment ${sale.sale_number}`,
      createdBy
    });
  }

  return {
    success: true,
    message: 'Deferred payment settled successfully',
    sale: {
      _id: sale._id,
      sale_number: sale.sale_number,
      amount_paid: sale.amount_paid,
      balance_due: sale.balance_due,
      discount_applied: discountAmount,
      status: sale.status
    }
  };
}

module.exports = {
  objectIdOrUndefined,
  getHospitalId,
  getCreatedBy,
  normalizeMoney,
  frequencyToPerDay,
  parseDurationDays,
  parseDoseQty,
  calculateRequiredBaseUnits,
  getAdvanceBalance,
  createAdvanceLedgerEntry,
  buildSaleItems,
  calculateTotals,
  createUnifiedSale,
  createReturn,
  createOutstandingSettlement,
  bulkSettleDeferredPayments,
  settleSingleDeferredPayment,
  validateDeferredPaymentReturn,
  handleDeferredPaymentReturn,
  getPatientOutstanding,
  getPatientPharmacySummary,
  normalizePaymentsWithOverpayment
};