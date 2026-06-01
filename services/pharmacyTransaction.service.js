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
  if (['IPDAdvance', 'PharmacyAdvance', 'Insurance', 'Credit', 'Pending', 'Adjustment', 'NoPayment'].includes(method)) return 'NON_CASH';
  return 'IN';
}

function normalizePayments({ total, payment_method, payments, noPayment = false }) {
  if (noPayment || payment_method === 'Pending' || payment_method === 'Credit' || payment_method === 'NoPayment') {
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

function calculateItemTaxesAndProfit(item, rawItem = {}, medicine = {}, batch = {}) {
  const quantity = Number(item.quantity_base_units || 0);
  const gross = normalizeMoney(quantity * Number(item.rate_per_base_unit || 0));
  const discountAmount = normalizeMoney(rawItem.discount_amount || rawItem.discountAmount || item.discount_amount || 0);
  const taxable = normalizeMoney(Math.max(0, gross - discountAmount));
  const taxRate = Number(rawItem.tax_rate ?? rawItem.taxRate ?? medicine.gst_rate ?? medicine.tax_rate ?? 0);
  const taxAmount = normalizeMoney(taxable * taxRate / 100);
  const cgstRate = taxRate > 0 ? normalizeMoney(taxRate / 2) : 0;
  const sgstRate = taxRate > 0 ? normalizeMoney(taxRate / 2) : 0;
  const purchaseRate = Number(rawItem.purchase_rate_per_base_unit || rawItem.purchaseRatePerBaseUnit || batch.purchase_price_per_base_unit || ((batch.purchase_price || 0) / (item.units_per_pack || 1)) || 0);
  const purchaseAmount = normalizeMoney(quantity * purchaseRate);
  const net = normalizeMoney(taxable + taxAmount);
  const grossProfit = normalizeMoney(taxable - purchaseAmount);

  return {
    gross_amount: gross,
    discount_amount: discountAmount,
    taxable_amount: taxable,
    tax_rate: taxRate,
    cgst_rate: cgstRate,
    sgst_rate: sgstRate,
    cgst_amount: normalizeMoney(taxAmount / 2),
    sgst_amount: normalizeMoney(taxAmount / 2),
    tax_amount: taxAmount,
    total_price: net,
    net_amount: net,
    purchase_rate_per_base_unit: purchaseRate,
    purchase_amount: purchaseAmount,
    gross_profit: grossProfit
  };
}

async function buildSaleItems(rawItems = [], { honorLooseSale = true, defaultDoctor = {} } = {}) {
  const items = [];
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
    const ratePerPack = Number(rawItem.rate_per_pack || batch.selling_price_per_pack || batch.selling_price || ratePerBaseUnit * unitsPerPack || 0);
    const doctorId = objectIdOrUndefined(rawItem.doctor_id || rawItem.doctorId || rawItem.prescribed_by || rawItem.prescribedBy || defaultDoctor.doctorId);
    const doctorName = normalizeText(rawItem.doctor_name || rawItem.doctorName || rawItem.prescribed_by_name || rawItem.prescribedByName || defaultDoctor.doctorName);

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
      rate_per_pack: ratePerPack,
      discount: Number(rawItem.discount || 0),
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
      _batch: batch,
      _medicine: medicine
    };

    Object.assign(item, calculateItemTaxesAndProfit(item, rawItem, medicine, batch));
    if (item.commission_type === 'Percentage') item.commission_amount = normalizeMoney(item.taxable_amount * item.commission_value / 100);
    else if (item.commission_type === 'Fixed') item.commission_amount = normalizeMoney(item.commission_value * item.quantity_base_units);
    else item.commission_amount = 0;

    items.push(item);
  }
  return items;
}

function calculateTotals(items, { discount = 0, discount_type = 'percentage', tax_rate = null } = {}) {
  const itemGross = normalizeMoney(items.reduce((sum, item) => sum + Number(item.gross_amount || 0), 0));
  const itemDiscount = normalizeMoney(items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0));
  const afterItemDiscount = normalizeMoney(itemGross - itemDiscount);
  const billDiscountValue = Number(discount || 0);
  const billDiscountAmount = normalizeMoney(discount_type === 'percentage' ? afterItemDiscount * (billDiscountValue / 100) : Math.min(billDiscountValue, afterItemDiscount));
  const taxableBeforeBillTax = normalizeMoney(Math.max(0, afterItemDiscount - billDiscountAmount));

  let tax = normalizeMoney(items.reduce((sum, item) => sum + Number(item.tax_amount || 0), 0));
  if (tax_rate != null && tax_rate !== '') tax = normalizeMoney(taxableBeforeBillTax * Number(tax_rate || 0) / 100);

  const total = normalizeMoney(taxableBeforeBillTax + tax);
  const purchaseCost = normalizeMoney(items.reduce((sum, item) => sum + Number(item.purchase_amount || 0), 0));
  const profit = normalizeMoney(taxableBeforeBillTax - purchaseCost);
  return {
    subtotal: afterItemDiscount,
    grossAmount: itemGross,
    itemDiscount,
    discountAmount: billDiscountAmount,
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

async function createSaleInvoice({ sale, items, customerName, customerPhone, totals, paymentEntries, createdBy }) {
  const customerType = sale.customer_type === 'WalkIn' || sale.customer_type === 'walkin' ? 'Walk-in' : 'Patient';
  const amountPaid = normalizeMoney(Math.min(sale.amount_paid || 0, sale.net_amount_after_returns || sale.total_amount || 0));
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
      prescription_id: sale.prescription_id || undefined,
      is_dispensed: true,
      dispensed_at: new Date()
    })),
    subtotal: totals.subtotal,
    discount: normalizeMoney((totals.itemDiscount || 0) + (totals.discountAmount || 0)),
    tax: totals.tax,
    total: totals.total,
    amount_paid: amountPaid,
    payments: paymentEntries.filter(p => !['Pending', 'Credit', 'NoPayment'].includes(p.method)).map(p => ({
      amount: p.amount,
      method: ['Insurance', 'Government Scheme'].includes(p.method) ? 'Insurance' : p.method,
      reference: p.reference,
      collected_by: createdBy
    })).filter(p => p.amount > 0 && ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme'].includes(p.method)),
    status: sale.balance_due <= 0 ? 'Paid' : amountPaid > 0 ? 'Partial' : 'Pending',
    is_pharmacy_sale: true,
    dispensing_date: new Date(),
    dispensed_by: createdBy,
    created_by: createdBy,
    notes: sale.notes
  });
  sale.invoice_id = invoice._id;
  sale.invoice_number = invoice.invoice_number;
  await sale.save();
  return invoice;
}

async function createPharmacyBill({ sale, items, totals, paymentEntries, hospitalId, patientId, admissionId, createdBy }) {
  // Build bill items from sale items
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
    discount_amount: item.discount_amount || 0,
    prescription_id: sale.prescription_id,
    prescription_item_id: item.prescription_item_id,
    admission_id: admissionId,
    doctor_id: item.doctor_id,
    doctor_name: item.doctor_name
  }));

  // Get pharmacy balances before
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

  // Calculate payment amount
  if (paymentEntries && paymentEntries.length > 0) {
    paymentAmount = paymentEntries.reduce((sum, p) => sum + p.amount, 0);
  } else if (sale.payment_method !== 'NoPayment' && sale.payment_method !== 'Pending') {
    paymentAmount = totals.total;
  }

  // Handle advance usage
  if (sale.payment_method === 'PharmacyAdvance' || (paymentEntries && paymentEntries.some(p => p.method === 'PharmacyAdvance'))) {
    pharmacyAdvanceUsed = Math.min(pharmacyAdvanceBefore, paymentAmount);
  }

  // Handle overpayment -> advance creation
  let overpayment = 0;
  if (paymentAmount > totals.total) {
    overpayment = paymentAmount - totals.total;
    pharmacyAdvanceCreated = overpayment;
  }

  const pharmacyOutstandingAfter = Math.max(0, totals.total - paymentAmount + pharmacyOutstandingBefore - pharmacyAdvanceUsed);
  const pharmacyAdvanceAfter = pharmacyAdvanceBefore - pharmacyAdvanceUsed + pharmacyAdvanceCreated;

  // Create the bill
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
    payment_method: sale.payment_method,
    payments: paymentEntries.map(p => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference,
      date: new Date()
    })),
    items: billItems,
    status: sale.payment_method === 'NoPayment' ? 'Pending' : (paymentAmount >= totals.total ? 'Paid' : 'Partially Paid'),
    paid_amount: paymentAmount,
    balance_due: totals.total - paymentAmount,
    created_by: createdBy,
    notes: sale.notes || `Pharmacy sale: ${sale.sale_number}`,
    is_pharmacy_bill: true,
    pharmacy_outstanding_before: pharmacyOutstandingBefore,
    pharmacy_outstanding_after: pharmacyOutstandingAfter,
    pharmacy_advance_used: pharmacyAdvanceUsed,
    pharmacy_advance_created: pharmacyAdvanceCreated,
    advance_balance_after: pharmacyAdvanceAfter
  });

  // Link bill to sale
  sale.bill_id = bill._id;
  await sale.save();

  // Update patient pharmacy balances
  if (patientId) {
    await Patient.findByIdAndUpdate(patientId, {
      $inc: {
        pharmacy_outstanding_balance: (totals.total - paymentAmount - pharmacyAdvanceUsed),
        pharmacy_advance_balance: (pharmacyAdvanceCreated - pharmacyAdvanceUsed)
      },
      last_pharmacy_transaction: new Date()
    });
  }

  return bill;
}

async function createIpdChargeForSale({ sale, total, createdBy }) {
  if (!sale.admission_id || !sale.patient_id) return null;
  return IPDCharge.create({
    admissionId: sale.admission_id,
    patientId: sale.patient_id,
    chargeType: 'Pharmacy',
    description: `Pharmacy medicines - ${sale.sale_number}`,
    quantity: 1,
    rate: total,
    amount: total,
    netAmount: total,
    sourceModule: 'Pharmacy',
    sourceId: sale._id,
    isAutoGenerated: true,
    isBilled: true,
    invoiceId: sale.invoice_id,
    billedAt: new Date(),
    sourceReference: { module: 'Pharmacy', documentId: sale._id, invoiceNumber: sale.invoice_number, billNumber: sale.sale_number },
    addedBy: createdBy,
    notes: 'Auto-created from pharmacy sale'
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
  if (sale.discount_amount > 0) {
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'DISCOUNT',
      direction: 'NON_CASH',
      amount: normalizeMoney(sale.discount_amount),
      paymentMethod: 'Adjustment',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: sale.discount_reason || 'Sale discount',
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

async function createUnifiedSale(payload, req = {}) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId);
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId);
  const prescriptionId = objectIdOrUndefined(payload.prescription_id || payload.prescriptionId);
  const context = await resolvePatientContext({ patientId, admissionId, prescriptionId, explicit: payload });

  const items = await buildSaleItems(payload.items || [], { honorLooseSale: payload.allowLooseSale !== false, defaultDoctor: { doctorId: context.doctorId, doctorName: context.doctorName } });
  const totals = calculateTotals(items, payload);
  const previousOutstanding = await getPatientOutstanding({ patientId, admissionId });
  const previousPharmacyAdvance = await getAdvanceBalance({ patientId, admissionId, walletType: 'PHARMACY_IPD' });
  const noPayment = payload.noPayment === true || payload.pay_nothing === true;
  const payments = normalizePayments({ total: totals.total, payment_method: payload.payment_method || payload.paymentMethod, payments: payload.payments, noPayment });
  const totalReceived = normalizeMoney(payments.reduce((sum, p) => sum + p.amount, 0));
  const paymentForCurrent = Math.min(totalReceived, totals.total);
  const currentDue = normalizeMoney(Math.max(0, totals.total - paymentForCurrent));
  const extraTendered = normalizeMoney(Math.max(0, totalReceived - paymentForCurrent));

  const shouldSettleOutstanding = payload.payOutstanding === true || payload.pay_outstanding === true || Number(payload.outstanding_payment_amount || payload.outstandingPaymentAmount || 0) > 0;
  const requestedOutstandingPayment = shouldSettleOutstanding
    ? normalizeMoney(payload.outstanding_payment_amount || payload.outstandingPaymentAmount || previousOutstanding)
    : 0;
  const outstandingPaymentAmount = normalizeMoney(Math.min(extraTendered, requestedOutstandingPayment || extraTendered, previousOutstanding));
  const overpaymentToAdvance = normalizeMoney(Math.max(0, extraTendered - outstandingPaymentAmount));

  const balanceDue = noPayment ? totals.total : currentDue;
  const saleStatus = balanceDue <= 0 ? 'Completed' : 'Pending';

  for (const p of payments) await validateAdvancePayment({ p, patientId, admissionId });

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
    amount_paid: paymentForCurrent,
    settlement_amount: outstandingPaymentAmount,
    balance_due: balanceDue,
    closing_outstanding: normalizeMoney(previousOutstanding - outstandingPaymentAmount + balanceDue),
    pharmacy_advance_before: previousPharmacyAdvance,
    overpayment_amount: overpaymentToAdvance,
    overpayment_credited_to: overpaymentToAdvance > 0 ? 'PHARMACY_IPD' : null,
    total_purchase_cost: totals.purchaseCost,
    gross_profit: totals.profit,
    commission_amount: totals.commissionAmount,
    return_amount: 0,
    net_amount_after_returns: totals.total,
    payment_method: noPayment ? 'Pending' : payments.length > 1 ? 'Split' : payments[0]?.method || 'Pending',
    payments,
    status: saleStatus,
    notes: payload.notes,
    created_by: createdBy
  });

  await deductStockAndCreateLedger({ items, hospitalId, pharmacyId, saleId: sale._id, createdBy });
  const invoice = await createSaleInvoice({ sale, items, customerName: sale.customer_name, customerPhone: sale.customer_phone, totals, paymentEntries: payments, createdBy });
  const bill = await createPharmacyBill({ sale, items, totals, paymentEntries: payments, hospitalId, patientId, admissionId, createdBy });
  await createIpdChargeForSale({ sale, total: totals.total, createdBy });
  await applyIpdMedicineStock({ items, sale, hospitalId, admissionId, patientId });

  const currentPaymentBreakup = allocatePaymentsForAmount(payments, paymentForCurrent);
  for (const p of currentPaymentBreakup) await consumeAdvancePayment({ p, sale, hospitalId, patientId, admissionId, createdBy });
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

  if (overpaymentToAdvance > 0 && patientId) {
    await createAdvanceLedgerEntry({
      hospitalId,
      patientId,
      admissionId,
      walletType: 'PHARMACY_IPD',
      transactionType: 'PHARMACY_OVERPAYMENT_CREDIT',
      direction: 'CREDIT',
      amount: overpaymentToAdvance,
      paymentMethod: payments[0]?.method || 'Cash',
      referenceNumber: payments[0]?.reference,
      sourceModule: 'Pharmacy',
      sourceId: sale._id,
      notes: `Round/extra payment credited from ${sale.sale_number}`,
      createdBy
    });
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: 'ADVANCE_RECEIVED',
      direction: 'IN',
      amount: overpaymentToAdvance,
      paymentMethod: payments[0]?.method || 'Cash',
      patientId,
      admissionId,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Extra payment credited to pharmacy advance for ${sale.sale_number}`,
      createdBy
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
    .populate('admission_id', 'admissionNumber status paymentType advanceAmount')
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
    overpayment_advance: overpaymentToAdvance > 0 ? { amount: overpaymentToAdvance, credited_to: 'PHARMACY_IPD' } : null,
    balances: finalSummary
  };
}

async function createReturn(payload, req = {}) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const originalSaleId = objectIdOrUndefined(payload.originalSaleId || payload.original_sale_id || payload.saleId || payload.sale_id);
  const originalSale = originalSaleId ? await Sale.findById(originalSaleId) : null;
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId || originalSale?.admission_id);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId || originalSale?.patient_id);

  const items = [];
  for (const raw of payload.items || []) {
    const medicineId = objectIdOrUndefined(raw.medicineId || raw.medicine_id);
    const batchId = objectIdOrUndefined(raw.batchId || raw.batch_id);
    const saleItem = originalSale?.items?.id?.(raw.saleItemId || raw.sale_item_id) || originalSale?.items?.find?.(i => String(i.medicine_id) === String(medicineId) && (!batchId || String(i.batch_id) === String(batchId)));
    const medicine = medicineId ? await Medicine.findById(medicineId) : null;
    const batch = batchId ? await MedicineBatch.findById(batchId) : null;
    const qty = Number(raw.returnedQtyBaseUnits || raw.quantity_base_units || raw.quantity || 0);
    if (qty <= 0) throw new Error('Return quantity must be greater than zero.');
    if (saleItem) {
      const alreadyReturned = Number(saleItem.returned_quantity_base_units || 0);
      const soldQty = Number(saleItem.quantity_base_units || saleItem.quantity || 0);
      if (alreadyReturned + qty > soldQty + 0.0001) throw new Error(`Return quantity for ${saleItem.medicine_name} exceeds original sale quantity.`);
    }
    if (admissionId && medicineId) {
      const stock = await IPDPatientMedicineStock.findOne({ admissionId, patientId, medicineId, ...(batchId ? { batchId } : {}) });
      if (stock && Number(stock.currentBalanceBaseUnits || 0) < qty) throw new Error(`Return quantity for ${stock.medicineName} exceeds patient balance.`);
    }
    const ratePerBaseUnit = Number(raw.ratePerBaseUnit || raw.rate_per_base_unit || saleItem?.rate_per_base_unit || batch?.selling_price_per_base_unit || 0);
    const discountReversal = Number(raw.discountReversal || raw.discount_reversal || 0);
    const grossAmount = normalizeMoney(qty * ratePerBaseUnit);
    const taxableAmount = normalizeMoney(Math.max(0, grossAmount - discountReversal));
    const taxRate = Number(raw.tax_rate ?? raw.taxRate ?? saleItem?.tax_rate ?? medicine?.gst_rate ?? 0);
    const taxAmount = normalizeMoney(taxableAmount * taxRate / 100);
    const refundAmount = normalizeMoney(taxableAmount + taxAmount);
    items.push({
      saleItemId: saleItem?._id,
      medicineId,
      batchId,
      medicineName: raw.medicineName || raw.medicine_name || saleItem?.medicine_name || medicine?.name || 'Medicine',
      returnedQtyBaseUnits: qty,
      baseUnit: raw.baseUnit || raw.base_unit || saleItem?.base_unit || medicine?.base_unit || 'unit',
      unitsPerPack: Number(raw.unitsPerPack || raw.units_per_pack || saleItem?.units_per_pack || batch?.units_per_pack || medicine?.units_per_pack || 1),
      ratePerBaseUnit,
      grossAmount,
      discountReversal,
      taxableAmount,
      taxRate,
      taxAmount,
      refundAmount,
      purchaseRatePerBaseUnit: Number(saleItem?.purchase_rate_per_base_unit || batch?.purchase_price_per_base_unit || 0),
      condition: raw.condition || 'SEALED_USABLE',
      restock: raw.restock !== false && (raw.condition || 'SEALED_USABLE') === 'SEALED_USABLE'
    });
  }

  const pharmacyReturn = await PharmacyReturn.create({
    hospitalId,
    pharmacyId,
    originalSaleId,
    originalInvoiceId: objectIdOrUndefined(payload.originalInvoiceId || payload.original_invoice_id || originalSale?.invoice_id),
    originalSaleNumber: originalSale?.sale_number,
    patientId,
    admissionId,
    returnType: payload.returnType || payload.return_type || (admissionId ? 'IPD_UNUSED_MEDICINE' : patientId ? 'OPD_RETURN' : 'WALKIN_RETURN'),
    items,
    totalRefundAmount: normalizeMoney(items.reduce((sum, item) => sum + item.refundAmount, 0)),
    refundMode: payload.refundMode || payload.refund_mode || 'PharmacyAdvance',
    refundReference: payload.refundReference || payload.refund_reference,
    status: payload.status || 'Completed',
    notes: payload.notes,
    createdBy
  });

  await restockAndCreateLedger({ items: pharmacyReturn.items, hospitalId, pharmacyId, returnId: pharmacyReturn._id, createdBy });

  if (admissionId && patientId) {
    for (const item of pharmacyReturn.items) {
      await IPDPatientMedicineStock.findOneAndUpdate(
        { admissionId, patientId, medicineId: item.medicineId, ...(item.batchId ? { batchId: item.batchId } : {}) },
        { $inc: { returnedQtyBaseUnits: item.returnedQtyBaseUnits, currentBalanceBaseUnits: -item.returnedQtyBaseUnits }, $set: { lastReturnedAt: new Date() } },
        { new: true }
      );
    }
  }

  const refundAmount = normalizeMoney(pharmacyReturn.totalRefundAmount);
  const refundMode = pharmacyReturn.refundMode;

  if (originalSale) {
    for (const retItem of pharmacyReturn.items) {
      const saleItem = retItem.saleItemId ? originalSale.items.id(retItem.saleItemId) : originalSale.items.find(i => String(i.medicine_id) === String(retItem.medicineId) && (!retItem.batchId || String(i.batch_id) === String(retItem.batchId)));
      if (saleItem) {
        saleItem.returned_quantity_base_units = Number(saleItem.returned_quantity_base_units || 0) + Number(retItem.returnedQtyBaseUnits || 0);
        saleItem.returned_amount = normalizeMoney(Number(saleItem.returned_amount || 0) + Number(retItem.refundAmount || 0));
      }
    }
    originalSale.return_refs = originalSale.return_refs || [];
    originalSale.return_refs.push({ return_id: pharmacyReturn._id, return_number: pharmacyReturn.returnNumber, amount: refundAmount, returned_at: new Date() });
    originalSale.return_amount = normalizeMoney(Number(originalSale.return_amount || 0) + refundAmount);
    originalSale.net_amount_after_returns = normalizeMoney(Math.max(0, Number(originalSale.total_amount || 0) - Number(originalSale.return_amount || 0)));
    originalSale.balance_due = normalizeMoney(Math.max(0, Number(originalSale.balance_due || 0) - refundAmount));
    originalSale.status = originalSale.return_amount >= originalSale.total_amount ? 'Refunded' : 'PartiallyReturned';
    await originalSale.save();
  }

  if (refundAmount > 0 && admissionId && patientId && ['IPDAdvance', 'PharmacyAdvance'].includes(refundMode)) {
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
  }

  await PharmacyLedgerEntry.create({
    hospitalId,
    pharmacyId,
    entryType: ['Cash', 'UPI', 'Card'].includes(refundMode) ? 'REFUND' : 'RETURN',
    direction: ['Cash', 'UPI', 'Card'].includes(refundMode) ? 'OUT' : 'NON_CASH',
    amount: refundAmount,
    paymentMethod: refundMode === 'IPDAdvance' ? 'IPDAdvance' : refundMode === 'PharmacyAdvance' ? 'PharmacyAdvance' : refundMode === 'NoRefund' ? 'Adjustment' : refundMode,
    patientId,
    admissionId,
    saleId: originalSale?._id,
    returnId: pharmacyReturn._id,
    invoiceId: originalSale?.invoice_id,
    notes: `Return ${pharmacyReturn.returnNumber}${originalSale ? ` against ${originalSale.sale_number}` : ''}`,
    createdBy
  });

  // Update associated bill if exists
  if (originalSale && originalSale.bill_id) {
    const bill = await Bill.findById(originalSale.bill_id);
    if (bill) {
      bill.notes = bill.notes 
        ? `${bill.notes}\nReturn ${pharmacyReturn.returnNumber}: ₹${refundAmount}`
        : `Return ${pharmacyReturn.returnNumber}: ₹${refundAmount}`;
      await bill.save();
    }
  }

  const balances = await getPatientPharmacySummary({ patientId, admissionId });
  pharmacyReturn.patientOutstandingAfter = balances.outstanding;
  pharmacyReturn.pharmacyAdvanceAfter = balances.pharmacyAdvance;
  await pharmacyReturn.save();
  return pharmacyReturn;
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
  getPatientOutstanding,
  getPatientPharmacySummary,
  normalizePaymentsWithOverpayment
};