const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');
const Invoice = require('../models/Invoice');
const PurchaseOrder = require('../models/PurchaseOrder');
const Sale = require('../models/Sale');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const NursingNote = require('../models/NursingNote');
const Patient = require('../models/Patient');
const IPDAdmission = require('../models/IPDAdmission');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const PharmacyReturn = require('../models/PharmacyReturn');
const { createUnifiedSale } = require('../services/pharmacyTransaction.service');
const { userHospitalId } = require('../utils/hospitalScope');

// ========== HELPER FUNCTIONS ==========
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMoney = (value) => {
  return Number(toNumber(value).toFixed(2));
};

// Valid GST rates in India
const VALID_GST_RATES = [0, 5, 12, 18, 28];
const VALID_BASE_UNITS = ['tablet', 'capsule', 'ml', 'vial', 'ampoule', 'bottle', 'tube', 'sachet', 'piece', 'unit', 'other'];
const VALID_PACK_UNITS = ['strip', 'box', 'bottle', 'tube', 'vial', 'ampoule', 'sachet', 'piece', 'unit', 'other'];
const normaliseMedicineUnit = (value, fallback, allowed) => allowed.includes(String(value || '').trim()) ? String(value).trim() : fallback;

// Validate HSN code format (4-8 digits)
const validateHSNCode = (code) => {
  if (!code || code.trim() === '') return false;
  return /^\d{4,8}$/.test(code.trim());
};

// Validate GST rate
const validateGSTRate = (rate) => {
  const gstRate = Number(rate);
  if (isNaN(gstRate)) return false;
  return VALID_GST_RATES.includes(gstRate);
};

const resolvePurchaseTaxRates = (item = {}, fallbackGstRate = 0) => {
  const hasCgst = item.cgst_rate !== undefined && item.cgst_rate !== null && item.cgst_rate !== '';
  const hasSgst = item.sgst_rate !== undefined && item.sgst_rate !== null && item.sgst_rate !== '';
  let cgstRate;
  let sgstRate;
  if (hasCgst || hasSgst) {
    cgstRate = Math.max(0, toNumber(item.cgst_rate, 0));
    sgstRate = Math.max(0, toNumber(item.sgst_rate, 0));
  } else {
    const gst = Math.max(0, toNumber(item.gst_rate ?? fallbackGstRate, 0));
    cgstRate = gst / 2;
    sgstRate = gst / 2;
  }
  const gstRate = Number((cgstRate + sgstRate).toFixed(4));
  if (!validateGSTRate(gstRate)) {
    throw new Error(`CGST + SGST must equal an allowed GST rate (${VALID_GST_RATES.join(', ')}%).`);
  }
  return { gstRate, cgstRate, sgstRate };
};

// Helper function to generate timing slots for IPD medications
function generateTimingSlots(frequency, durationDays) {
  const timingSlots = [];
  const freqTimingMap = {
    'OD': ['08:00'],
    'BD': ['08:00', '20:00'],
    'TDS': ['08:00', '14:00', '20:00'],
    'QDS': ['06:00', '12:00', '18:00', '22:00'],
    'q4h': ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'],
    'q6h': ['06:00', '12:00', '18:00', '00:00'],
    'q8h': ['06:00', '14:00', '22:00'],
    'q12h': ['08:00', '20:00'],
    'Stat': ['now'],
    'SOS': []
  };

  const times = freqTimingMap[frequency] || ['08:00'];
  const today = operationNow();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < durationDays; d++) {
    const slotDate = new Date(today);
    slotDate.setDate(today.getDate() + d);

    for (const t of times) {
      timingSlots.push({
        date: slotDate,
        time: t,
        status: 'Pending'
      });
    }
  }

  return timingSlots;
}

// Helper function to add to patient medicine stock
async function addToPatientMedicineStock(admissionId, patientId, medicineId, batchId, quantity, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit, saleId, medicationChartId) {
  try {
    let stock = await IPDPatientMedicineStock.findOne({
      admissionId,
      patientId,
      medicineId,
      batchId
    });

    if (!stock) {
      stock = new IPDPatientMedicineStock({
        admissionId,
        patientId,
        medicineId,
        batchId,
        medicineName,
        baseUnit: baseUnit || 'unit',
        packUnit: packUnit || 'pack',
        unitsPerPack: unitsPerPack || 1,
        issuedQtyBaseUnits: 0,
        administeredQtyBaseUnits: 0,
        returnedQtyBaseUnits: 0,
        currentBalanceBaseUnits: 0,
        sourceSaleIds: [],
        medicationChartIds: []
      });
    }

    stock.issuedQtyBaseUnits += quantity;
    stock.currentBalanceBaseUnits += quantity;

    if (saleId && !stock.sourceSaleIds.includes(saleId)) {
      stock.sourceSaleIds.push(saleId);
    }

    if (medicationChartId && !stock.medicationChartIds.includes(medicationChartId)) {
      stock.medicationChartIds.push(medicationChartId);
    }

    stock.lastIssuedAt = operationNow();
    await stock.save();

    return stock;
  } catch (error) {
    console.error('Error adding to patient medicine stock:', error);
    throw error;
  }
}

// Helper function to get advance balance
async function getAdvanceBalance({ admissionId, patientId, walletType }) {
  const result = await PatientAdvanceLedger.aggregate([
    { 
      $match: { 
        admissionId: admissionId, 
        patientId: patientId, 
        walletType: walletType 
      } 
    },
    {
      $group: {
        _id: null,
        balance: {
          $sum: {
            $cond: [{ $eq: ['$direction', 'CREDIT'] }, '$amount', { $multiply: ['$amount', -1] }]
          }
        }
      }
    }
  ]);
  return result[0]?.balance || 0;
}

const getPurchaseOrderDateFilter = (dateFilter) => {
  if (!dateFilter) return null;
  const now = operationNow();
  const start = new Date(now);
  const end = new Date(now);
  if (dateFilter === 'today') {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (dateFilter === 'week') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    start.setDate(now.getDate() + diffToMonday);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime());
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (dateFilter === 'month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(start.getMonth() + 1);
    end.setDate(0);
    end.setHours(23, 59, 59, 999);
  } else if (dateFilter === 'quarter') {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    start.setMonth(quarterStartMonth, 1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(quarterStartMonth + 3, 0);
    end.setHours(23, 59, 59, 999);
  } else {
    return null;
  }
  return { $gte: start, $lte: end };
};

const getMedicineUnitInfo = async (medicineId) => {
  if (!medicineId) return { medicine: null, unitsPerPack: 1, hsnCode: undefined, gstRate: undefined };
  const medicine = await Medicine.findById(medicineId).select(
    'units_per_pack pack_unit base_unit mrp selling_price price_per_unit hsn_code gst_rate'
  );
  return {
    medicine,
    unitsPerPack: Math.max(1, toNumber(medicine?.units_per_pack, 1)),
    hsnCode: medicine?.hsn_code,
    gstRate: medicine?.gst_rate
  };
};

// Helper function to generate invoice number
async function generateInvoiceNumber() {
  const year = operationNow().getFullYear();
  const month = String(operationNow().getMonth() + 1).padStart(2, '0');

  const lastInvoice = await Invoice.findOne({
    invoice_number: new RegExp(`^INV-${year}${month}`)
  }).sort({ createdAt: -1 });

  let sequence = 1;
  if (lastInvoice && lastInvoice.invoice_number) {
    const lastSeq = parseInt(lastInvoice.invoice_number.split('-').pop());
    if (!isNaN(lastSeq)) {
      sequence = lastSeq + 1;
    }
  }

  return `INV-${year}${month}-${String(sequence).padStart(4, '0')}`;
}

// ========== PURCHASE ORDER FUNCTIONS ==========

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, items, notes, expected_delivery } = req.body;
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one purchase order item is required.' });

    let subtotal = 0;
    let totalTax = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    const validatedItems = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {};
      const medicineId = item.medicine_id || null;
      const medicine = medicineId ? await Medicine.findById(medicineId).select('name generic_name brand strength category dosage_form base_unit pack_unit units_per_pack hsn_code gst_rate') : null;
      if (medicineId && !medicine) {
        return res.status(400).json({ error: `Medicine master was not found for line ${index + 1}. Select it again or use a manual/non-NLEM line.` });
      }

      const manualLine = !medicine || item.catalog_source === 'MANUAL_NON_NLEM' || item.is_non_nlem === true;
      const medicineName = String(item.medicine_name || medicine?.name || '').trim();
      if (!medicineName) return res.status(400).json({ error: `Medicine name is required for line ${index + 1}.` });

      const quantity = toNumber(item.quantity, 0);
      const unitCost = roundMoney(item.unit_cost);
      if (quantity < 1) return res.status(400).json({ error: `Quantity must be at least 1 pack for "${medicineName}".` });
      if (unitCost < 0) return res.status(400).json({ error: `Unit cost cannot be negative for "${medicineName}".` });

      const hsnCode = String(item.hsn_code || medicine?.hsn_code || '').trim();
      if (!validateHSNCode(hsnCode)) {
        return res.status(400).json({ error: `A valid 4–8 digit HSN code is required for "${medicineName}".` });
      }
      let taxRates;
      try {
        taxRates = resolvePurchaseTaxRates(item, medicine?.gst_rate ?? 0);
      } catch (taxError) {
        return res.status(400).json({ error: `${taxError.message} Medicine: "${medicineName}".` });
      }
      const { gstRate, cgstRate, sgstRate } = taxRates;

      const unitsPerPack = Math.max(1, toNumber(item.units_per_pack ?? medicine?.units_per_pack, 1));
      const itemSubtotal = roundMoney(quantity * unitCost);
      const cgstAmount = roundMoney((itemSubtotal * cgstRate) / 100);
      const sgstAmount = roundMoney((itemSubtotal * sgstRate) / 100);
      const itemTax = roundMoney(cgstAmount + sgstAmount);
      subtotal += itemSubtotal;
      totalCgst += cgstAmount;
      totalSgst += sgstAmount;
      totalTax += itemTax;

      validatedItems.push({
        medicine_id: medicine?._id || null,
        medicine_name: medicineName,
        catalog_source: manualLine ? 'MANUAL_NON_NLEM' : 'MASTER',
        is_non_nlem: manualLine,
        generic_name: String(item.generic_name || medicine?.generic_name || '').trim(),
        brand: String(item.brand || medicine?.brand || '').trim(),
        strength: String(item.strength || medicine?.strength || '').trim(),
        dosage_form: String(item.dosage_form || medicine?.dosage_form || '').trim(),
        category: String(item.category || medicine?.category || (manualLine ? 'Other' : '')).trim(),
        base_unit: normaliseMedicineUnit(item.base_unit || medicine?.base_unit, 'tablet', VALID_BASE_UNITS),
        pack_unit: normaliseMedicineUnit(item.pack_unit || medicine?.pack_unit, 'strip', VALID_PACK_UNITS),
        units_per_pack: unitsPerPack,
        hsn_code: hsnCode,
        gst_rate: toNumber(gstRate),
        cgst_rate: cgstRate,
        sgst_rate: sgstRate,
        quantity,
        received: 0,
        quantity_base_units: quantity * unitsPerPack,
        received_base_units: 0,
        unit_cost: unitCost,
        total_cost: itemSubtotal,
        tax_amount: itemTax,
        cgst_amount: cgstAmount,
        sgst_amount: sgstAmount,
        batch_number: item.batch_number || '',
        expiry_date: item.expiry_date || null,
        selling_price: Math.max(0, toNumber(item.selling_price, 0)),
      });
    }

    const purchaseOrder = new PurchaseOrder({
      hospitalId: userHospitalId(req.user) || null,
      supplier_id,
      items: validatedItems,
      subtotal: roundMoney(subtotal),
      tax: roundMoney(totalTax),
      cgst: roundMoney(totalCgst),
      sgst: roundMoney(totalSgst),
      total_amount: roundMoney(subtotal + totalTax),
      notes: String(notes || '').trim(),
      expected_delivery: expected_delivery ? new Date(expected_delivery) : null,
      status: 'Ordered',
      created_by: req.user?._id || null,
    });
    await purchaseOrder.save();

    const invoice = new Invoice({
      hospital_id: userHospitalId(req.user),
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: 'Supplier Purchase',
      purchase_order_id: purchaseOrder._id,
      issue_date: operationNow(),
      due_date: new Date(operationNow().getTime() + 30 * 24 * 60 * 60 * 1000),
      service_items: validatedItems.map((item) => ({
        description: `Purchase - ${item.medicine_name} (HSN: ${item.hsn_code}, CGST: ${item.cgst_rate}% + SGST: ${item.sgst_rate}%)`,
        quantity: item.quantity,
        unit_price: item.unit_cost,
        total_price: item.total_cost,
        tax_rate: item.gst_rate,
        tax_amount: item.tax_amount,
        service_type: 'Purchase',
        hsn_code: item.hsn_code,
      })),
      subtotal: purchaseOrder.subtotal,
      tax: purchaseOrder.tax,
      total: purchaseOrder.total_amount,
      status: 'Issued',
      notes: `Purchase Order: ${purchaseOrder.order_number} - ${purchaseOrder.notes || ''}`,
    });
    await invoice.save();

    purchaseOrder.invoice_id = invoice._id;
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');

    res.status(201).json({
      success: true,
      message: 'Purchase order created successfully.',
      purchaseOrder: populatedPurchaseOrder,
      invoice,
      gst_summary: {
        subtotal: purchaseOrder.subtotal,
        total_tax: purchaseOrder.tax,
        total_amount: purchaseOrder.total_amount,
        cgst: roundMoney(purchaseOrder.cgst),
        sgst: roundMoney(purchaseOrder.sgst),
      },
      manual_non_nlem_lines: validatedItems.filter((item) => item.catalog_source === 'MANUAL_NON_NLEM').map((item) => item.medicine_name),
    });
  } catch (err) {
    console.error('Error creating purchase order:', err);
    res.status(400).json({ error: err.message || 'Unable to create purchase order.' });
  }
};

exports.getAllPurchaseOrders = async (req, res) => {
  try {
    const {
      status,
      page = 1,
      limit = 10,
      supplier,
      date,
      search,
      sort = 'order_date',
      order = 'desc',
    } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const dateFilter = getPurchaseOrderDateFilter(date);
    if (dateFilter) filter.order_date = dateFilter;

    let supplierIds = null;
    if (supplier) {
      const Supplier = require('../models/Supplier');
      const matchingSuppliers = await Supplier.find({
        name: { $regex: supplier, $options: 'i' },
      }).select('_id');
      supplierIds = matchingSuppliers.map((item) => item._id);
      filter.supplier_id = { $in: supplierIds };
    }

    if (search) {
      const Supplier = require('../models/Supplier');
      const matchingSuppliers = await Supplier.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { contactPerson: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      filter.$or = [
        { order_number: { $regex: search, $options: 'i' } },
        { supplier_id: { $in: matchingSuppliers.map((item) => item._id) } },
      ];
    }

    const sortDirection = order === 'asc' ? 1 : -1;
    const allowedSortFields = ['order_date', 'total_amount', 'status', 'createdAt'];
    const sortField = allowedSortFields.includes(sort) ? sort : 'order_date';

    const orders = await PurchaseOrder.find(filter)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name')
      .sort({ [sortField]: sortDirection })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await PurchaseOrder.countDocuments(filter);

    res.json({
      orders,
      totalPages: Math.ceil(total / Number(limit)),
      currentPage: Number(page),
      total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPurchaseOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await PurchaseOrder.findById(id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * A manual PO line remains master-less until receipt. This prevents a cancelled
 * purchase order from creating a false stock master. The receipt creates one
 * local/non-NLEM medicine exactly once and reuses it for partial receipts.
 */
async function resolveOrderItemMedicine({ order, orderItem, user }) {
  if (orderItem.medicine_id) {
    const existing = await Medicine.findById(orderItem.medicine_id);
    if (!existing) throw new Error(`Medicine master not found for "${orderItem.medicine_name}".`);
    return { medicine: existing, materialized: false };
  }

  const existingFromOrder = await Medicine.findOne({
    created_from_purchase_order_id: order._id,
    name: orderItem.medicine_name,
  });
  if (existingFromOrder) {
    orderItem.medicine_id = existingFromOrder._id;
    orderItem.materialized_at = orderItem.materialized_at || operationNow();
    return { medicine: existingFromOrder, materialized: false };
  }

  if (!orderItem.is_non_nlem && orderItem.catalog_source !== 'MANUAL_NON_NLEM') {
    throw new Error(`A medicine master is required for "${orderItem.medicine_name}".`);
  }
  if (!validateHSNCode(orderItem.hsn_code)) throw new Error(`A valid HSN code is required for "${orderItem.medicine_name}".`);
  if (!validateGSTRate(orderItem.gst_rate)) throw new Error(`A valid GST rate is required for "${orderItem.medicine_name}".`);

  const medicine = await Medicine.create({
    hospitalId: order.hospitalId || userHospitalId(user) || null,
    name: orderItem.medicine_name,
    generic_name: orderItem.generic_name || '',
    brand: orderItem.brand || '',
    strength: orderItem.strength || '',
    category: orderItem.category || 'Other',
    hsn_code: orderItem.hsn_code,
    gst_rate: toNumber(orderItem.gst_rate),
    base_unit: normaliseMedicineUnit(orderItem.base_unit, 'tablet', VALID_BASE_UNITS),
    pack_unit: normaliseMedicineUnit(orderItem.pack_unit, 'strip', VALID_PACK_UNITS),
    units_per_pack: Math.max(1, toNumber(orderItem.units_per_pack, 1)),
    allow_loose_sale: true,
    catalog_source: 'LOCAL_NON_NLEM',
    created_from_purchase_order_id: order._id,
    is_active: true,
  });

  orderItem.medicine_id = medicine._id;
  orderItem.materialized_at = operationNow();
  return { medicine, materialized: true };
}

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { received_items = [] } = req.body;
    if (!Array.isArray(received_items) || received_items.length === 0) {
      return res.status(400).json({ error: 'received_items array is required.' });
    }

    const order = await PurchaseOrder.findById(id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (!['Ordered', 'Partially Received'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot receive stock for order with status ${order.status}.` });
    }

    const createdBatches = [];
    const createdLocalMedicines = [];
    for (const receivedItem of received_items) {
      const orderItem = order.items.id(receivedItem.item_id);
      if (!orderItem) return res.status(400).json({ error: `Purchase order item not found: ${receivedItem.item_id}.` });

      const alreadyReceivedPacks = toNumber(orderItem.received, 0);
      const orderedPacks = toNumber(orderItem.quantity, 0);
      const pendingPacks = Math.max(0, orderedPacks - alreadyReceivedPacks);
      const receivedPacks = Math.max(0, toNumber(receivedItem.quantity_received_packs ?? receivedItem.quantity_received, 0));
      const freePacks = Math.max(0, toNumber(receivedItem.free_packs, 0));
      const totalPacks = Math.max(0, toNumber(receivedItem.total_received_packs, receivedPacks + freePacks));

      if (receivedPacks <= 0 && freePacks <= 0) continue;
      if (receivedPacks > pendingPacks) {
        return res.status(400).json({ error: `Cannot receive ${receivedPacks} packs for ${orderItem.medicine_name}. Pending quantity is ${pendingPacks} packs.` });
      }

      // Receipt-side fields are controlled updates for batch data. Tax and the
      // manual medicine snapshot stay on the order line for audit consistency.
      if (receivedItem.hsn_code) orderItem.hsn_code = String(receivedItem.hsn_code).trim();
      if (receivedItem.gst_rate !== undefined) orderItem.gst_rate = toNumber(receivedItem.gst_rate, -1);
      if (receivedItem.cgst_rate !== undefined) orderItem.cgst_rate = toNumber(receivedItem.cgst_rate, -1);
      if (receivedItem.sgst_rate !== undefined) orderItem.sgst_rate = toNumber(receivedItem.sgst_rate, -1);
      const receiptTaxRates = resolvePurchaseTaxRates(orderItem.toObject ? orderItem.toObject() : orderItem, orderItem.gst_rate);
      orderItem.gst_rate = receiptTaxRates.gstRate;
      orderItem.cgst_rate = receiptTaxRates.cgstRate;
      orderItem.sgst_rate = receiptTaxRates.sgstRate;
      if (receivedItem.units_per_pack !== undefined) orderItem.units_per_pack = Math.max(1, toNumber(receivedItem.units_per_pack, 1));
      if (receivedItem.base_unit) orderItem.base_unit = normaliseMedicineUnit(receivedItem.base_unit, orderItem.base_unit || 'tablet', VALID_BASE_UNITS);
      if (receivedItem.pack_unit) orderItem.pack_unit = normaliseMedicineUnit(receivedItem.pack_unit, orderItem.pack_unit || 'strip', VALID_PACK_UNITS);

      if (!validateHSNCode(orderItem.hsn_code)) return res.status(400).json({ error: `A valid HSN code is required for ${orderItem.medicine_name}.` });
      if (!validateGSTRate(orderItem.gst_rate)) return res.status(400).json({ error: `A valid GST rate is required for ${orderItem.medicine_name}.` });

      const { medicine, materialized } = await resolveOrderItemMedicine({ order, orderItem, user: req.user });
      if (materialized) createdLocalMedicines.push(medicine);

      const unitsPerPack = Math.max(1, toNumber(receivedItem.units_per_pack ?? orderItem.units_per_pack ?? medicine.units_per_pack, 1));
      const quantityBaseUnits = Math.max(0, toNumber(receivedItem.quantity_received_base_units, totalPacks * unitsPerPack));
      const batchNumber = String(receivedItem.batch_number || orderItem.batch_number || '').trim();
      const expiryDate = receivedItem.expiry_date || orderItem.expiry_date;
      if (!batchNumber) return res.status(400).json({ error: `Batch number is required for ${orderItem.medicine_name}.` });
      if (!expiryDate) return res.status(400).json({ error: `Expiry date is required for ${orderItem.medicine_name}.` });
      const expiry = new Date(expiryDate);
      const today = operationNow(); today.setHours(0, 0, 0, 0);
      if (Number.isNaN(expiry.getTime()) || expiry <= today) return res.status(400).json({ error: `Expiry date must be in the future for ${orderItem.medicine_name}.` });

      const purchasePricePerPack = roundMoney(receivedItem.purchase_price_per_pack ?? receivedItem.purchase_price ?? orderItem.unit_cost ?? 0);
      const sellingPricePerPack = roundMoney(receivedItem.selling_price_per_pack ?? receivedItem.selling_price ?? orderItem.selling_price ?? medicine.selling_price ?? medicine.mrp ?? purchasePricePerPack);
      const mrpPerPack = roundMoney(receivedItem.mrp_per_pack ?? orderItem.mrp_per_pack ?? medicine.mrp ?? sellingPricePerPack);
      const purchasePricePerBaseUnit = roundMoney(receivedItem.purchase_price_per_base_unit ?? purchasePricePerPack / unitsPerPack);
      const sellingPricePerBaseUnit = roundMoney(receivedItem.selling_price_per_base_unit ?? sellingPricePerPack / unitsPerPack);

      const batch = new MedicineBatch({
        medicine_id: medicine._id,
        batch_number: batchNumber,
        expiry_date: expiry,
        quantity: quantityBaseUnits,
        quantity_base_units: quantityBaseUnits,
        opening_quantity_base_units: quantityBaseUnits,
        units_per_pack: unitsPerPack,
        purchase_price: purchasePricePerPack,
        selling_price: sellingPricePerPack,
        purchase_price_per_pack: purchasePricePerPack,
        selling_price_per_pack: sellingPricePerPack,
        mrp_per_pack: mrpPerPack,
        purchase_price_per_base_unit: purchasePricePerBaseUnit,
        selling_price_per_base_unit: sellingPricePerBaseUnit,
        supplier_id: order.supplier_id,
        purchase_date: order.order_date || operationNow(),
        received_date: operationNow(),
        is_active: true,
      });
      await batch.save();
      createdBatches.push(batch);

      orderItem.received = alreadyReceivedPacks + receivedPacks;
      if (freePacks > 0) {
        orderItem.free_packs = toNumber(orderItem.free_packs, 0) + freePacks;
      }
      orderItem.batch_number = batchNumber;
      orderItem.expiry_date = expiry;
      orderItem.selling_price = sellingPricePerPack;
      orderItem.units_per_pack = unitsPerPack;
      orderItem.quantity_base_units = toNumber(orderItem.quantity_base_units, orderedPacks * unitsPerPack);
      orderItem.received_base_units = toNumber(orderItem.received_base_units, 0) + quantityBaseUnits;

      await Medicine.findByIdAndUpdate(medicine._id, {
        $set: {
          units_per_pack: unitsPerPack,
          hsn_code: orderItem.hsn_code,
          gst_rate: orderItem.gst_rate,
        },
      });
    }

    const totalOrderedPacks = order.items.reduce((sum, item) => sum + toNumber(item.quantity, 0), 0);
    const totalReceivedPacks = order.items.reduce((sum, item) => sum + toNumber(item.received, 0), 0);
    order.status = totalReceivedPacks <= 0 ? 'Ordered' : (totalReceivedPacks < totalOrderedPacks ? 'Partially Received' : 'Received');
    order.received_date = order.status === 'Received' ? operationNow() : order.received_date;
    await order.save();

    const populatedOrder = await PurchaseOrder.findById(order._id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');

    res.json({
      success: true,
      message: 'Purchase order stock received successfully.',
      order: populatedOrder,
      createdBatches,
      createdLocalMedicines,
      gst_summary: {
        total_batches: createdBatches.length,
        batches: createdBatches.map((batch) => ({
          batch_number: batch.batch_number,
          medicine_name: populatedOrder.items.find((item) => String(item.medicine_id?._id || item.medicine_id) === String(batch.medicine_id))?.medicine_name,
          hsn_code: batch.tax_snapshot?.hsn_code,
          gst_rate: batch.tax_snapshot?.gst_rate,
          quantity: batch.quantity_base_units,
        })),
      },
    });
  } catch (err) {
    console.error('Error receiving purchase order:', err);
    res.status(400).json({ error: 'Failed to receive purchase order', message: err.message });
  }
};

exports.getPurchaseOrderStatistics = async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.order_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    if (status) filter.status = status;

    const stats = await PurchaseOrder.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: '$total_amount' },
          totalTax: { $sum: '$tax' },
          averageOrderValue: { $avg: '$total_amount' },
          ordersByStatus: {
            $push: {
              status: '$status',
              amount: '$total_amount'
            }
          }
        }
      },
      {
        $unwind: '$ordersByStatus'
      },
      {
        $group: {
          _id: {
            status: '$ordersByStatus.status'
          },
          totalOrders: { $first: '$totalOrders' },
          totalAmount: { $first: '$totalAmount' },
          totalTax: { $first: '$totalTax' },
          averageOrderValue: { $first: '$averageOrderValue' },
          statusCount: { $sum: 1 },
          statusAmount: { $sum: '$ordersByStatus.amount' }
        }
      },
      {
        $group: {
          _id: null,
          totalOrders: { $first: '$totalOrders' },
          totalAmount: { $first: '$totalAmount' },
          totalTax: { $first: '$totalTax' },
          averageOrderValue: { $first: '$averageOrderValue' },
          statusBreakdown: {
            $push: {
              status: '$_id.status',
              count: '$statusCount',
              amount: '$statusAmount',
              percentage: {
                $multiply: [
                  { $divide: ['$statusCount', '$totalOrders'] },
                  100
                ]
              }
            }
          }
        }
      }
    ]);

    res.json(stats[0] || {
      totalOrders: 0,
      totalAmount: 0,
      totalTax: 0,
      averageOrderValue: 0,
      statusBreakdown: []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== PURCHASE ORDER GST SUMMARY ==========
exports.getPurchaseOrderGSTSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = {};
    if (startDate && endDate) {
      matchStage.order_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const gstSummary = await PurchaseOrder.aggregate([
      { $match: matchStage },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'medicines',
          localField: 'items.medicine_id',
          foreignField: '_id',
          as: 'medicine_info'
        }
      },
      { $unwind: { path: '$medicine_info', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: {
            hsn_code: { $ifNull: ['$items.hsn_code', '$medicine_info.hsn_code'] },
            gst_rate: { $ifNull: ['$items.gst_rate', '$medicine_info.gst_rate'] }
          },
          hsn_code: { $first: { $ifNull: ['$items.hsn_code', '$medicine_info.hsn_code'] } },
          gst_rate: { $first: { $ifNull: ['$items.gst_rate', '$medicine_info.gst_rate'] } },
          total_quantity: { $sum: '$items.quantity' },
          total_value: { $sum: { $multiply: ['$items.quantity', '$items.unit_cost'] } },
          total_tax: { $sum: { $multiply: [
            { $multiply: ['$items.quantity', '$items.unit_cost'] },
            { $divide: [{ $ifNull: ['$items.gst_rate', '$medicine_info.gst_rate'] }, 100] }
          ] } }
        }
      },
      { $sort: { hsn_code: 1 } }
    ]);
    
    const summary = {
      total_purchase_value: gstSummary.reduce((sum, item) => sum + item.total_value, 0),
      total_tax: gstSummary.reduce((sum, item) => sum + item.total_tax, 0),
      unique_hsn_codes: gstSummary.length,
      by_hsn: gstSummary,
      by_rate: gstSummary.reduce((acc, item) => {
        const rate = item.gst_rate;
        if (!acc[rate]) {
          acc[rate] = { rate, total_value: 0, total_tax: 0, count: 0 };
        }
        acc[rate].total_value += item.total_value;
        acc[rate].total_tax += item.total_tax;
        acc[rate].count += 1;
        return acc;
      }, {})
    };
    
    res.json({
      success: true,
      period: { start: startDate, end: endDate },
      summary,
      by_rate: Object.values(summary.by_rate)
    });
  } catch (err) {
    console.error('Error getting purchase order GST summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== SALE FUNCTIONS ==========

exports.createSale = async (req, res) => {
  try {
    // Validate GST for each item before sale
    const items = req.body.items || [];
    for (const item of items) {
      if (item.batch_id) {
        const batch = await MedicineBatch.findById(item.batch_id).populate('medicine_id');
        if (batch) {
          const gstRate = batch.gst_rate || batch.medicine_id?.gst_rate;
          if (gstRate === undefined || gstRate === null) {
            return res.status(400).json({
              error: `GST rate not found for batch ${batch.batch_number}. Please check the batch.`
            });
          }
          if (!validateGSTRate(gstRate)) {
            return res.status(400).json({
              error: `Invalid GST rate ${gstRate}% for batch ${batch.batch_number}`
            });
          }
        }
      }
    }
    
    // Use unified sale service for all transactions
    const result = await createUnifiedSale(req.body, req);
    return res.status(201).json({
      success: true,
      message: 'Sale created successfully',
      ...result,
      sale: result.sale,
      invoice: result.invoice,
      gst_summary: result.totals ? {
        subtotal: result.totals.subtotal,
        total_tax: result.totals.tax,
        total_amount: result.totals.total,
        cgst: result.totals.tax / 2,
        sgst: result.totals.tax / 2
      } : null
    });
  } catch (err) {
    console.error('Error creating sale:', err);
    
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({
        error: 'Validation failed',
        details: errors,
        message: err.message
      });
    }
    
    res.status(400).json({
      error: 'Failed to create sale',
      message: err.message
    });
  }
};

exports.getSaleById = async (req, res) => {
  try {
    const { id } = req.params;
    const sale = await Sale.findById(id)
      .populate('patient_id', 'first_name last_name patientId uhid phone dob gender')
      .populate('admission_id', 'admissionNumber shipNumber status')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('items.medicine_id', 'name composition hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date hsn_code gst_rate')
      .populate('created_by', 'name')
      .lean();

    if (!sale) return res.status(404).json({ error: 'Sale not found' });

    const returns = sale.return_refs?.length > 0
      ? await PharmacyReturn.find({ _id: { $in: sale.return_refs.map((r) => r.return_id) } })
      : [];

    const gstSummary = {
      subtotal: sale.subtotal || 0,
      total_tax: sale.tax || 0,
      total_amount: sale.total_amount || 0,
      cgst: (sale.tax || 0) / 2,
      sgst: (sale.tax || 0) / 2
    };

    return res.json({ success: true, sale, returns, gst_summary: gstSummary });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.updateSalePayment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const additionalPayment = roundMoney(req.body.additional_payment);
    const paymentMethod = req.body.payment_method;
    const notes = req.body.notes;

    if (!(additionalPayment > 0)) {
      return res.status(400).json({ error: 'A positive additional_payment is required' });
    }

    let responsePayload;
    await session.withTransaction(async () => {
      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        const error = new Error('Sale not found'); error.statusCode = 404; throw error;
      }

      // IPD pharmacy money must flow through the authoritative settlement/final
      // clearance services so bill/invoice/advance/clearance state cannot diverge.
      if (sale.admission_id) {
        const error = new Error(
          'IPD sale payments must be recorded through Pharmacy ledger settlement/final clearance, not the legacy sale-payment endpoint.'
        );
        error.statusCode = 409;
        error.code = 'IPD_SALE_PAYMENT_REQUIRES_PHARMACY_SETTLEMENT';
        throw error;
      }

      if (sale.status === 'Cancelled') {
        const error = new Error('Cancelled sales cannot receive payment'); error.statusCode = 409; throw error;
      }
      if (sale.status === 'Completed' && Number(sale.balance_due || 0) <= 0) {
        const error = new Error('Sale is already fully paid'); error.statusCode = 400; throw error;
      }

      const newPaymentAmount = Math.min(additionalPayment, Number(sale.balance_due || 0));
      const newPaidAmount = roundMoney(Number(sale.amount_paid || 0) + newPaymentAmount);
      const newBalanceDue = roundMoney(Math.max(0, Number(sale.total_amount || 0) - newPaidAmount));

      sale.amount_paid = newPaidAmount;
      sale.balance_due = newBalanceDue;
      sale.status = newBalanceDue === 0 ? 'Completed' : 'Pending';
      sale.payments.push({
        method: paymentMethod,
        amount: newPaymentAmount,
        reference: req.body.reference,
        date: operationNow()
      });
      await sale.save({ session });

      await PharmacyLedgerEntry.create([{
        hospitalId: sale.hospitalId || userHospitalId(req.user),
        pharmacyId: sale.pharmacy_id,
        entryType: 'OUTSTANDING_PAYMENT',
        direction: 'IN',
        amount: newPaymentAmount,
        paymentMethod,
        patientId: sale.patient_id,
        admissionId: null,
        saleId: sale._id,
        notes: notes || `Payment received for sale ${sale.sale_number}`,
        createdBy: req.user?._id
      }], { session });

      responsePayload = {
        _id: sale._id,
        amount_paid: sale.amount_paid,
        balance_due: sale.balance_due,
        status: sale.status
      };
    });

    return res.json({ success: true, message: 'Payment recorded successfully', sale: responsePayload });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  } finally {
    await session.endSession();
  }
};

exports.voidSale = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });

    let result;
    await session.withTransaction(async () => {
      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        const error = new Error('Sale not found'); error.statusCode = 404; throw error;
      }
      if (sale.status === 'Cancelled') {
        const error = new Error('Sale is already cancelled'); error.statusCode = 400; throw error;
      }

      // An IPD issue changes bedside stock, MAR dispatch, IPD/pharmacy ledgers,
      // invoices and clearance. It may only be reversed through the canonical
      // pharmacy return/credit workflow, which updates those records atomically.
      if (sale.admission_id) {
        const error = new Error(
          'IPD sales cannot be voided through the legacy endpoint. Use the Pharmacy return/credit workflow.'
        );
        error.statusCode = 409;
        error.code = 'IPD_SALE_REVERSAL_REQUIRES_RETURN';
        throw error;
      }

      for (const item of sale.items || []) {
        const batch = await MedicineBatch.findById(item.batch_id).session(session);
        if (!batch) continue;
        batch.quantity_base_units = Number(batch.quantity_base_units || 0) + Number(item.quantity_base_units || 0);
        batch.quantity = batch.quantity_base_units;
        await batch.save({ session });
        await Medicine.findByIdAndUpdate(
          item.medicine_id,
          { $inc: { stock_quantity: Number(item.quantity_base_units || 0) } },
          { session }
        );
      }

      sale.status = 'Cancelled';
      sale.notes = `${sale.notes || ''}\n[CANCELLED] ${operationNow().toISOString()}: ${reason}`.trim();
      await sale.save({ session });
      result = { _id: sale._id, sale_number: sale.sale_number, status: sale.status };
    });

    return res.json({ success: true, message: 'Sale cancelled successfully', sale: result });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  } finally {
    await session.endSession();
  }
};

exports.getSalesByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { limit = 50, page = 1 } = req.query;
    const patient = await Patient.findById(patientId)
      .select('first_name last_name patientId uhid');
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const filter = { patient_id: patientId };
    const sales = await Sale.find(filter)
      .populate('admission_id', 'admissionNumber shipNumber')
      .populate('doctor_id', 'firstName lastName')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .sort({ sale_date: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    const total = await Sale.countDocuments(filter);

    return res.json({
      success: true, patient, sales, total,
      page: Number(page), totalPages: Math.ceil(total / Number(limit))
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getSalesByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId uhid');
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const sales = await Sale.find({ admission_id: admissionId })
      .populate('doctor_id', 'firstName lastName')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .sort({ sale_date: -1 });

    const totals = sales.reduce((acc, sale) => {
      acc.totalAmount += Number(sale.total_amount || 0);
      acc.totalPaid += Number(sale.amount_paid || 0);
      acc.totalDue += Number(sale.balance_due || 0);
      acc.totalTax += Number(sale.tax || 0);
      return acc;
    }, { totalAmount: 0, totalPaid: 0, totalDue: 0, totalTax: 0 });

    return res.json({
      success: true, admission, sales, totals,
      gst_summary: { total_tax: totals.totalTax, cgst: totals.totalTax / 2, sgst: totals.totalTax / 2 }
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getPendingPrescriptions = async (req, res) => {
  try {
    const { limit = 20, page = 1 } = req.query;
    const filter = {
      status: 'Active',
      $or: [
        { is_dispensed: false },
        { items: { $elemMatch: { is_dispensed: false } } }
      ]
    };

    const prescriptions = await Prescription.find(filter)
      .populate('patient_id', 'first_name last_name patientId uhid phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('items.medicine_id', 'name composition hsn_code gst_rate')
      .sort({ created_at: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    const total = await Prescription.countDocuments(filter);
    const prescriptionsWithCount = prescriptions.map((pres) => ({
      ...pres.toObject(),
      undispensedItemsCount: pres.items?.filter((item) => !item.is_dispensed).length || 0,
      totalItems: pres.items?.length || 0
    }));

    return res.json({
      success: true, prescriptions: prescriptionsWithCount, total,
      page: Number(page), totalPages: Math.ceil(total / Number(limit))
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getRecentSales = async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const recentSales = await Sale.find({})
      .populate('patient_id', 'first_name last_name patientId')
      .populate('admission_id', 'admissionNumber')
      .populate('doctor_id', 'firstName lastName')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .sort({ sale_date: -1 })
      .limit(Number(limit))
      .lean();

    const todayStart = operationNow();
    todayStart.setHours(0, 0, 0, 0);
    const todaySales = await Sale.aggregate([
      { $match: { sale_date: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$total_amount' }, tax: { $sum: '$tax' }, count: { $sum: 1 } } }
    ]);

    return res.json({
      success: true, recentSales,
      todayStats: {
        total: todaySales[0]?.total || 0,
        tax: todaySales[0]?.tax || 0,
        count: todaySales[0]?.count || 0,
        cgst: (todaySales[0]?.tax || 0) / 2,
        sgst: (todaySales[0]?.tax || 0) / 2
      }
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getAllSales = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 10, patientId, admissionId, status } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.sale_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    if (patientId) filter.patient_id = patientId;
    if (admissionId) filter.admission_id = admissionId;
    if (status) filter.status = status;

    const sales = await Sale.find(filter)
      .populate('patient_id')
      .populate('admission_id', 'admissionNumber shipNumber')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .populate('created_by', 'name')
      .sort({ sale_date: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Sale.countDocuments(filter);

    res.json({
      sales,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSalesStatistics = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.sale_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    let groupFormat;
    switch (groupBy) {
      case 'hour':
        groupFormat = { hour: { $hour: '$sale_date' } };
        break;
      case 'day':
        groupFormat = {
          year: { $year: '$sale_date' },
          month: { $month: '$sale_date' },
          day: { $dayOfMonth: '$sale_date' }
        };
        break;
      case 'month':
        groupFormat = {
          year: { $year: '$sale_date' },
          month: { $month: '$sale_date' }
        };
        break;
      case 'year':
        groupFormat = { year: { $year: '$sale_date' } };
        break;
      default:
        groupFormat = {
          year: { $year: '$sale_date' },
          month: { $month: '$sale_date' },
          day: { $dayOfMonth: '$sale_date' }
        };
    }

    const salesStats = await Sale.aggregate([
      { $match: filter },
      {
        $group: {
          _id: groupFormat,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: '$total_amount' },
          totalTax: { $sum: '$tax' },
          averageSale: { $avg: '$total_amount' },
          minSale: { $min: '$total_amount' },
          maxSale: { $max: '$total_amount' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ]);

    res.json(salesStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDailySalesReport = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : operationNow();

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const dailyStats = await Sale.aggregate([
      {
        $match: {
          sale_date: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: '$total_amount' },
          totalTax: { $sum: '$tax' },
          averageSale: { $avg: '$total_amount' },
          salesByPaymentMethod: {
            $push: {
              method: '$payment_method',
              amount: '$total_amount'
            }
          }
        }
      },
      {
        $unwind: '$salesByPaymentMethod'
      },
      {
        $group: {
          _id: {
            method: '$salesByPaymentMethod.method'
          },
          totalSales: { $first: '$totalSales' },
          totalRevenue: { $first: '$totalRevenue' },
          totalTax: { $first: '$totalTax' },
          averageSale: { $first: '$averageSale' },
          methodCount: { $sum: 1 },
          methodRevenue: { $sum: '$salesByPaymentMethod.amount' }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $first: '$totalSales' },
          totalRevenue: { $first: '$totalRevenue' },
          totalTax: { $first: '$totalTax' },
          averageSale: { $first: '$averageSale' },
          paymentMethods: {
            $push: {
              method: '$_id.method',
              count: '$methodCount',
              revenue: '$methodRevenue',
              percentage: {
                $multiply: [
                  { $divide: ['$methodCount', '$totalSales'] },
                  100
                ]
              }
            }
          }
        }
      }
    ]);

    const dailySales = await Sale.find({
      sale_date: { $gte: startOfDay, $lte: endOfDay }
    })
      .populate('patient_id', 'first_name last_name')
      .populate('admission_id', 'admissionNumber')
      .populate('items.medicine_id', 'name')
      .sort({ sale_date: -1 });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      summary: dailyStats[0] || {
        totalSales: 0,
        totalRevenue: 0,
        totalTax: 0,
        averageSale: 0,
        paymentMethods: []
      },
      sales: dailySales,
      gst_breakdown: {
        cgst: (dailyStats[0]?.totalTax || 0) / 2,
        sgst: (dailyStats[0]?.totalTax || 0) / 2
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMonthlySalesReport = async (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || operationNow().getFullYear();
    const targetMonth = parseInt(month) || operationNow().getMonth() + 1;

    const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
    const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    const monthlyStats = await Sale.aggregate([
      {
        $match: {
          sale_date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$sale_date' },
            month: { $month: '$sale_date' },
            day: { $dayOfMonth: '$sale_date' }
          },
          dailySales: { $sum: 1 },
          dailyRevenue: { $sum: '$total_amount' },
          dailyTax: { $sum: '$tax' }
        }
      },
      {
        $group: {
          _id: {
            year: '$_id.year',
            month: '$_id.month'
          },
          totalSales: { $sum: '$dailySales' },
          totalRevenue: { $sum: '$dailyRevenue' },
          totalTax: { $sum: '$dailyTax' },
          averageDailySales: { $avg: '$dailySales' },
          averageDailyRevenue: { $avg: '$dailyRevenue' },
          bestDay: { $max: '$dailyRevenue' },
          worstDay: { $min: '$dailyRevenue' },
          daysWithSales: { $sum: 1 }
        }
      }
    ]);

    const topMedicines = await Sale.aggregate([
      {
        $match: {
          sale_date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.medicine_id',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unit_price'] } },
          averagePrice: { $avg: '$items.unit_price' }
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'medicines',
          localField: '_id',
          foreignField: '_id',
          as: 'medicine'
        }
      },
      { $unwind: '$medicine' }
    ]);

    res.json({
      month: targetMonth,
      year: targetYear,
      summary: monthlyStats[0] || {
        totalSales: 0,
        totalRevenue: 0,
        totalTax: 0,
        averageDailySales: 0,
        averageDailyRevenue: 0,
        bestDay: 0,
        worstDay: 0,
        daysWithSales: 0
      },
      topMedicines,
      gst_breakdown: {
        cgst: (monthlyStats[0]?.totalTax || 0) / 2,
        sgst: (monthlyStats[0]?.totalTax || 0) / 2
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getYearlySalesReport = async (req, res) => {
  try {
    const { year } = req.query;
    const targetYear = parseInt(year) || operationNow().getFullYear();

    const startOfYear = new Date(targetYear, 0, 1);
    const endOfYear = new Date(targetYear, 11, 31, 23, 59, 59, 999);

    const yearlyStats = await Sale.aggregate([
      {
        $match: {
          sale_date: { $gte: startOfYear, $lte: endOfYear }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$sale_date' },
            month: { $month: '$sale_date' }
          },
          monthlySales: { $sum: 1 },
          monthlyRevenue: { $sum: '$total_amount' },
          monthlyTax: { $sum: '$tax' }
        }
      },
      {
        $group: {
          _id: {
            year: '$_id.year'
          },
          totalSales: { $sum: '$monthlySales' },
          totalRevenue: { $sum: '$monthlyRevenue' },
          totalTax: { $sum: '$monthlyTax' },
          averageMonthlySales: { $avg: '$monthlySales' },
          averageMonthlyRevenue: { $avg: '$monthlyRevenue' },
          bestMonth: { $max: '$monthlyRevenue' },
          worstMonth: { $min: '$monthlyRevenue' },
          monthsWithSales: { $sum: 1 }
        }
      }
    ]);

    const monthlyBreakdown = await Sale.aggregate([
      {
        $match: {
          sale_date: { $gte: startOfYear, $lte: endOfYear }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$sale_date' },
            month: { $month: '$sale_date' }
          },
          sales: { $sum: 1 },
          revenue: { $sum: '$total_amount' },
          tax: { $sum: '$tax' }
        }
      },
      { $sort: { '_id.month': 1 } }
    ]);

    res.json({
      year: targetYear,
      summary: yearlyStats[0] || {
        totalSales: 0,
        totalRevenue: 0,
        totalTax: 0,
        averageMonthlySales: 0,
        averageMonthlyRevenue: 0,
        bestMonth: 0,
        worstMonth: 0,
        monthsWithSales: 0
      },
      monthlyBreakdown,
      gst_breakdown: {
        cgst: (yearlyStats[0]?.totalTax || 0) / 2,
        sgst: (yearlyStats[0]?.totalTax || 0) / 2
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getRevenueComparison = async (req, res) => {
  try {
    const { period = 'month', compareTo = 'previous' } = req.query;

    const currentDate = operationNow();
    let currentPeriod, previousPeriod;

    if (period === 'month') {
      currentPeriod = {
        start: new Date(currentDate.getFullYear(), currentDate.getMonth(), 1),
        end: new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0)
      };

      previousPeriod = {
        start: new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1),
        end: new Date(currentDate.getFullYear(), currentDate.getMonth(), 0)
      };
    } else {
      currentPeriod = {
        start: new Date(currentDate.getFullYear(), 0, 1),
        end: new Date(currentDate.getFullYear(), 11, 31)
      };

      previousPeriod = {
        start: new Date(currentDate.getFullYear() - 1, 0, 1),
        end: new Date(currentDate.getFullYear() - 1, 11, 31)
      };
    }

    const [currentStats, previousStats] = await Promise.all([
      Sale.aggregate([
        {
          $match: {
            sale_date: { $gte: currentPeriod.start, $lte: currentPeriod.end }
          }
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$total_amount' },
            tax: { $sum: '$tax' },
            salesCount: { $sum: 1 }
          }
        }
      ]),
      Sale.aggregate([
        {
          $match: {
            sale_date: { $gte: previousPeriod.start, $lte: previousPeriod.end }
          }
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$total_amount' },
            tax: { $sum: '$tax' },
            salesCount: { $sum: 1 }
          }
        }
      ])
    ]);

    const current = currentStats[0] || { revenue: 0, tax: 0, salesCount: 0 };
    const previous = previousStats[0] || { revenue: 0, tax: 0, salesCount: 0 };

    const revenueGrowth = previous.revenue > 0
      ? ((current.revenue - previous.revenue) / previous.revenue) * 100
      : current.revenue > 0 ? 100 : 0;

    const salesGrowth = previous.salesCount > 0
      ? ((current.salesCount - previous.salesCount) / previous.salesCount) * 100
      : current.salesCount > 0 ? 100 : 0;

    res.json({
      currentPeriod: {
        revenue: current.revenue,
        tax: current.tax,
        cgst: current.tax / 2,
        sgst: current.tax / 2,
        salesCount: current.salesCount,
        period: period === 'month' ? currentDate.toLocaleString('default', { month: 'long', year: 'numeric' }) : currentDate.getFullYear().toString()
      },
      previousPeriod: {
        revenue: previous.revenue,
        tax: previous.tax,
        cgst: previous.tax / 2,
        sgst: previous.tax / 2,
        salesCount: previous.salesCount,
        period: period === 'month'
          ? new Date(currentDate.getFullYear(), currentDate.getMonth() - 1).toLocaleString('default', { month: 'long', year: 'numeric' })
          : (currentDate.getFullYear() - 1).toString()
      },
      growth: {
        revenue: revenueGrowth,
        sales: salesGrowth,
        isPositive: revenueGrowth > 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};