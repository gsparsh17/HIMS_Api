const mongoose = require('mongoose');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const IPDCharge = require('../models/IPDCharge');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const InventoryLedger = require('../models/InventoryLedger');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const PharmacyReturn = require('../models/PharmacyReturn');

function objectIdOrUndefined(id) {
  return id && mongoose.Types.ObjectId.isValid(id) ? id : undefined;
}

function getHospitalId(req, explicitHospitalId) {
  return objectIdOrUndefined(explicitHospitalId || req.user?.hospital_id || req.body?.hospitalId || req.query?.hospitalId);
}

function getCreatedBy(req) {
  return objectIdOrUndefined(req.user?._id || req.user?.id);
}

function normalizeMoney(value) {
  return Number((Number(value || 0)).toFixed(2));
}

function frequencyToPerDay(frequency = '') {
  const raw = String(frequency || '').trim();
  const f = raw.toUpperCase();
  const map = {
    OD: 1,
    QD: 1,
    BD: 2,
    BID: 2,
    TDS: 3,
    TID: 3,
    QDS: 4,
    QID: 4,
    HS: 1,
    NOCTE: 1,
    MANE: 1,
    SOS: 0,
    STAT: 1
  };
  if (map[f] != null) return map[f];

  if (/^[01]-[01]-[01]$/.test(f)) {
    return f.split('-').reduce((sum, part) => sum + Number(part), 0);
  }

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

  if (!Number.isFinite(calculated) || calculated <= 0) {
    return Math.max(1, Number(item.quantity || 1));
  }
  return Math.ceil(calculated);
}

async function getAdvanceBalance({ admissionId, patientId, walletType = 'IPD_SHARED' }) {
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

async function createAdvanceLedgerEntry({ hospitalId, patientId, admissionId, walletType = 'IPD_SHARED', transactionType, direction, amount, paymentMethod, referenceNumber, sourceModule = 'Pharmacy', sourceId, notes, createdBy }) {
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

async function buildSaleItems(rawItems = [], { honorLooseSale = true } = {}) {
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

    if (!allowLoose) {
      quantityBaseUnits = Math.ceil(quantityBaseUnits / unitsPerPack) * unitsPerPack;
    }

    const available = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    if (available < quantityBaseUnits) {
      throw new Error(`Insufficient stock for ${medicine.name}. Available ${available} ${medicine.base_unit || 'unit'}, requested ${quantityBaseUnits}.`);
    }

    const ratePerBaseUnit = Number(rawItem.rate_per_base_unit || rawItem.unit_price || batch.selling_price_per_base_unit || (batch.selling_price || 0) / unitsPerPack || 0);
    const ratePerPack = Number(rawItem.rate_per_pack || batch.selling_price_per_pack || batch.selling_price || ratePerBaseUnit * unitsPerPack || 0);
    const gross = normalizeMoney(quantityBaseUnits * ratePerBaseUnit);
    const itemDiscountAmount = normalizeMoney(rawItem.discount_amount || 0);

    items.push({
      medicine_id: medicine._id,
      batch_id: batch._id,
      medicine_name: rawItem.medicine_name || rawItem.medicineName || medicine.name,
      batch_number: batch.batch_number,
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
      gross_amount: gross,
      discount: Number(rawItem.discount || 0),
      discount_amount: itemDiscountAmount,
      total_price: normalizeMoney(gross - itemDiscountAmount),
      prescription_item_id: objectIdOrUndefined(rawItem.prescription_item_id || rawItem.prescriptionItemId),
      ipd_medication_chart_id: objectIdOrUndefined(rawItem.ipd_medication_chart_id || rawItem.medicationChartId),
      _batch: batch,
      _medicine: medicine
    });
  }

  return items;
}

function calculateTotals(items, { discount = 0, discount_type = 'percentage', tax_rate = 0 } = {}) {
  const subtotal = normalizeMoney(items.reduce((sum, item) => sum + Number(item.total_price || item.gross_amount || 0), 0));
  const discountValue = Number(discount || 0);
  const discountAmount = normalizeMoney(discount_type === 'percentage' ? subtotal * (discountValue / 100) : Math.min(discountValue, subtotal));
  const taxable = Math.max(0, subtotal - discountAmount);
  const tax = normalizeMoney(taxable * (Number(tax_rate || 0) / 100));
  const total = normalizeMoney(taxable + tax);
  return { subtotal, discountAmount, tax, total };
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
    const query = {
      admissionId,
      patientId,
      medicineId: item.medicine_id,
      batchId: item.batch_id
    };
    const existing = await IPDPatientMedicineStock.findOne(query);
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
      $inc: {
        issuedQtyBaseUnits: item.quantity_base_units,
        currentBalanceBaseUnits: item.quantity_base_units
      },
      $addToSet: {
        sourceSaleIds: sale._id,
        ...(item.ipd_medication_chart_id ? { medicationChartIds: item.ipd_medication_chart_id } : {})
      },
      $set: { lastIssuedAt: new Date() }
    };
    const doc = await IPDPatientMedicineStock.findOneAndUpdate(query, update, { new: true, upsert: true });
    updates.push(doc);
  }

  return updates;
}

async function createSaleInvoice({ sale, items, customerName, customerPhone, total, subtotal, discountAmount, tax, paymentMethod, createdBy }) {
  const customerType = sale.customer_type === 'WalkIn' || sale.customer_type === 'walkin' ? 'Walk-in' : 'Patient';
  const amountPaid = sale.status === 'Pending' || paymentMethod === 'Pending' ? 0 : total;

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
      quantity: Math.max(1, item.quantity_base_units),
      unit_price: item.rate_per_base_unit,
      total_price: item.total_price || item.gross_amount,
      tax_rate: 0,
      tax_amount: 0,
      prescription_id: sale.prescription_id || undefined,
      is_dispensed: true,
      dispensed_at: new Date()
    })),
    subtotal,
    discount: discountAmount,
    tax,
    total,
    amount_paid: amountPaid,
    status: amountPaid >= total ? 'Paid' : amountPaid > 0 ? 'Partial' : 'Pending',
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

async function createIpdChargeForSale({ sale, total, createdBy }) {
  if (!sale.admission_id || !sale.patient_id) return null;
  const charge = await IPDCharge.create({
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
    sourceReference: {
      module: 'Pharmacy',
      documentId: sale._id,
      invoiceNumber: sale.invoice_number,
      billNumber: sale.sale_number
    },
    addedBy: createdBy,
    notes: 'Auto-created from pharmacy sale'
  });
  return charge;
}

async function createPharmacyLedgerForPayments({ payments, sale, hospitalId, pharmacyId, createdBy }) {
  for (const p of payments) {
    const method = p.method;
    await PharmacyLedgerEntry.create({
      hospitalId,
      pharmacyId,
      entryType: ['IPDAdvance', 'PharmacyAdvance'].includes(method) ? 'ADVANCE_USED' : 'SALE',
      direction: ['IPDAdvance', 'PharmacyAdvance'].includes(method) ? 'NON_CASH' : 'IN',
      amount: normalizeMoney(p.amount),
      paymentMethod: method,
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Payment for ${sale.sale_number}`,
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

function normalizePayments({ total, payment_method, payments }) {
  if (Array.isArray(payments) && payments.length > 0) {
    return payments.map(p => ({
      method: p.method || p.paymentMethod,
      amount: normalizeMoney(p.amount),
      reference: p.reference || p.referenceNumber || '',
      walletType: p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : p.method === 'IPDAdvance' ? 'IPD_SHARED' : null)
    }));
  }
  return [{
    method: payment_method || 'Cash',
    amount: normalizeMoney(total),
    reference: '',
    walletType: payment_method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : payment_method === 'IPDAdvance' ? 'IPD_SHARED' : null
  }];
}

async function createUnifiedSale(payload, req) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId);
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId);
  const prescriptionId = objectIdOrUndefined(payload.prescription_id || payload.prescriptionId);

  const items = await buildSaleItems(payload.items || [], { honorLooseSale: payload.allowLooseSale !== false });
  const totals = calculateTotals(items, payload);
  const payments = normalizePayments({ total: totals.total, payment_method: payload.payment_method || payload.paymentMethod, payments: payload.payments });
  const paidAmount = normalizeMoney(payments.reduce((sum, p) => sum + p.amount, 0));

  if (paidAmount + 0.01 < totals.total && payload.status !== 'Pending') {
    throw new Error(`Payment amount ${paidAmount} is less than bill total ${totals.total}. Use Pending/Credit or split payment.`);
  }

  for (const p of payments) {
    if (['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) {
      if (!admissionId || !patientId) throw new Error(`${p.method} can only be used for admitted IPD patients.`);
      const walletType = p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED');
      const balance = await getAdvanceBalance({ admissionId, patientId, walletType });
      if (balance + 0.01 < p.amount && payload.allowNegativeAdvance !== true) {
        throw new Error(`Insufficient ${walletType} balance. Available ₹${balance}, needed ₹${p.amount}.`);
      }
    }
  }

  const sale = await Sale.create({
    hospitalId,
    pharmacy_id: pharmacyId,
    customer_type: payload.customer_type || payload.customerType || (admissionId ? 'IPD' : patientId ? 'OPD' : 'WalkIn'),
    source_type: payload.source_type || payload.sourceType || (admissionId ? 'IPD_MEDICATION' : prescriptionId ? 'OPD_PRESCRIPTION' : 'DIRECT'),
    patient_id: patientId,
    admission_id: admissionId,
    prescription_id: prescriptionId,
    customer_name: payload.customer_name || payload.customerName,
    customer_phone: payload.customer_phone || payload.customerPhone,
    items: items.map(({ _batch, _medicine, ...item }) => item),
    subtotal: totals.subtotal,
    discount: Number(payload.discount || 0),
    discount_type: payload.discount_type || payload.discountType || 'percentage',
    discount_amount: totals.discountAmount,
    discount_reason: payload.discount_reason || payload.discountReason,
    tax_rate: Number(payload.tax_rate || payload.taxRate || 0),
    tax: totals.tax,
    total_amount: totals.total,
    amount_paid: paidAmount,
    balance_due: Math.max(0, normalizeMoney(totals.total - paidAmount)),
    payment_method: payments.length > 1 ? 'Split' : payments[0].method,
    payments,
    status: payload.status || (paidAmount >= totals.total ? 'Completed' : 'Pending'),
    notes: payload.notes,
    created_by: createdBy
  });

  await deductStockAndCreateLedger({ items, hospitalId, pharmacyId, saleId: sale._id, createdBy });
  const invoice = await createSaleInvoice({ sale, items, customerName: sale.customer_name, customerPhone: sale.customer_phone, ...totals, paymentMethod: sale.payment_method, createdBy });
  await createIpdChargeForSale({ sale, total: totals.total, createdBy });
  await applyIpdMedicineStock({ items, sale, hospitalId, admissionId, patientId });

  for (const p of payments) {
    if (['IPDAdvance', 'PharmacyAdvance'].includes(p.method)) {
      await createAdvanceLedgerEntry({
        hospitalId,
        patientId,
        admissionId,
        walletType: p.walletType || (p.method === 'PharmacyAdvance' ? 'PHARMACY_IPD' : 'IPD_SHARED'),
        transactionType: 'PHARMACY_SALE_DEBIT',
        direction: 'DEBIT',
        amount: p.amount,
        paymentMethod: p.method,
        referenceNumber: p.reference,
        sourceModule: 'Pharmacy',
        sourceId: sale._id,
        notes: `Pharmacy sale ${sale.sale_number}`,
        createdBy
      });
    }
  }

  await createPharmacyLedgerForPayments({ payments, sale, hospitalId, pharmacyId, createdBy });

  if (prescriptionId) {
    const prescription = await require('../models/Prescription').findById(prescriptionId);
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

  const populatedSale = await Sale.findById(sale._id)
    .populate('patient_id', 'first_name last_name patientId uhid phone')
    .populate('admission_id', 'admissionNumber status')
    .populate('items.medicine_id', 'name base_unit pack_unit units_per_pack')
    .populate('items.batch_id', 'batch_number expiry_date')
    .lean();

  return { sale: populatedSale, invoice };
}

async function createReturn(payload, req) {
  const hospitalId = getHospitalId(req, payload.hospitalId);
  const pharmacyId = objectIdOrUndefined(payload.pharmacyId || payload.pharmacy_id);
  const createdBy = getCreatedBy(req);
  const admissionId = objectIdOrUndefined(payload.admission_id || payload.admissionId);
  const patientId = objectIdOrUndefined(payload.patient_id || payload.patientId);

  const items = [];
  for (const raw of payload.items || []) {
    const medicineId = objectIdOrUndefined(raw.medicineId || raw.medicine_id);
    const batchId = objectIdOrUndefined(raw.batchId || raw.batch_id);
    const medicine = medicineId ? await Medicine.findById(medicineId) : null;
    const batch = batchId ? await MedicineBatch.findById(batchId) : null;
    const qty = Number(raw.returnedQtyBaseUnits || raw.quantity_base_units || raw.quantity || 0);
    if (qty <= 0) throw new Error('Return quantity must be greater than zero.');

    if (admissionId && medicineId) {
      const stock = await IPDPatientMedicineStock.findOne({ admissionId, medicineId, ...(batchId ? { batchId } : {}) });
      if (stock && Number(stock.currentBalanceBaseUnits || 0) < qty) {
        throw new Error(`Return quantity for ${stock.medicineName} exceeds patient balance.`);
      }
    }

    items.push({
      medicineId,
      batchId,
      medicineName: raw.medicineName || raw.medicine_name || medicine?.name || 'Medicine',
      returnedQtyBaseUnits: qty,
      baseUnit: raw.baseUnit || raw.base_unit || medicine?.base_unit || 'unit',
      unitsPerPack: Number(raw.unitsPerPack || raw.units_per_pack || batch?.units_per_pack || medicine?.units_per_pack || 1),
      ratePerBaseUnit: Number(raw.ratePerBaseUnit || raw.rate_per_base_unit || batch?.selling_price_per_base_unit || 0),
      discountReversal: Number(raw.discountReversal || raw.discount_reversal || 0),
      condition: raw.condition || 'SEALED_USABLE',
      restock: raw.restock !== false && (raw.condition || 'SEALED_USABLE') === 'SEALED_USABLE'
    });
  }

  const pharmacyReturn = await PharmacyReturn.create({
    hospitalId,
    pharmacyId,
    originalSaleId: objectIdOrUndefined(payload.originalSaleId || payload.original_sale_id),
    originalInvoiceId: objectIdOrUndefined(payload.originalInvoiceId || payload.original_invoice_id),
    patientId,
    admissionId,
    returnType: payload.returnType || payload.return_type || (admissionId ? 'IPD_UNUSED_MEDICINE' : patientId ? 'OPD_RETURN' : 'WALKIN_RETURN'),
    items,
    refundMode: payload.refundMode || payload.refund_mode || 'IPDAdvance',
    status: payload.status || 'Completed',
    notes: payload.notes,
    createdBy
  });

  await restockAndCreateLedger({ items: pharmacyReturn.items, hospitalId, pharmacyId, returnId: pharmacyReturn._id, createdBy });

  if (admissionId && patientId) {
    for (const item of pharmacyReturn.items) {
      await IPDPatientMedicineStock.findOneAndUpdate(
        { admissionId, patientId, medicineId: item.medicineId, ...(item.batchId ? { batchId: item.batchId } : {}) },
        {
          $inc: {
            returnedQtyBaseUnits: item.returnedQtyBaseUnits,
            currentBalanceBaseUnits: -item.returnedQtyBaseUnits
          },
          $set: { lastReturnedAt: new Date() }
        },
        { new: true }
      );
    }
  }

  const refundAmount = pharmacyReturn.totalRefundAmount;
  const refundMode = pharmacyReturn.refundMode;

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
    returnId: pharmacyReturn._id,
    notes: `Return ${pharmacyReturn.returnNumber}`,
    createdBy
  });

  return pharmacyReturn;
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
  createReturn
};
