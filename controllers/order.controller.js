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
  const today = new Date();
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

    stock.lastIssuedAt = new Date();
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
  const now = new Date();
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
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');

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

    // ========== GST VALIDATION ==========
    let subtotal = 0;
    let totalTax = 0;
    const validatedItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      // Get medicine details for GST validation
      let medicine = null;
      if (item.medicine_id) {
        medicine = await Medicine.findById(item.medicine_id).select('hsn_code gst_rate name');
      }
      
      const hsnCode = item.hsn_code || medicine?.hsn_code;
      const gstRate = item.gst_rate !== undefined ? item.gst_rate : medicine?.gst_rate;
      const medicineName = item.medicine_name || medicine?.name || 'Unknown Medicine';
      
      // Validate HSN code
      if (!hsnCode) {
        return res.status(400).json({
          error: `HSN code is required for "${medicineName}". Please update the medicine master or provide HSN code.`
        });
      }
      
      if (!validateHSNCode(hsnCode)) {
        return res.status(400).json({
          error: `Invalid HSN code "${hsnCode}" for "${medicineName}". HSN must be 4-8 digits.`
        });
      }
      
      // Validate GST rate
      if (gstRate === undefined || gstRate === null) {
        return res.status(400).json({
          error: `GST rate is required for "${medicineName}". Please update the medicine master.`
        });
      }
      
      if (!validateGSTRate(gstRate)) {
        return res.status(400).json({
          error: `Invalid GST rate ${gstRate}% for "${medicineName}". Valid rates: 0, 5, 12, 18, 28`
        });
      }
      
      // Calculate item totals
      const itemSubtotal = item.unit_cost * item.quantity;
      const itemTax = (itemSubtotal * gstRate) / 100;
      
      subtotal += itemSubtotal;
      totalTax += itemTax;
      
      validatedItems.push({
        ...item,
        hsn_code: hsnCode,
        gst_rate: gstRate,
        tax_amount: item.tax_amount || itemTax
      });
    }
    
    const total_amount = subtotal + totalTax;

    const purchaseOrder = new PurchaseOrder({
      supplier_id,
      items: validatedItems,
      subtotal,
      tax: totalTax,
      total_amount,
      notes,
      expected_delivery: expected_delivery ? new Date(expected_delivery) : null,
      status: 'Ordered',
      created_by: req.user?._id
    });

    await purchaseOrder.save();

    // Create invoice with GST breakdown
    const invoice = new Invoice({
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: 'Supplier Purchase',
      purchase_order_id: purchaseOrder._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      service_items: validatedItems.map(item => ({
        description: `Purchase - ${item.medicine_name || 'Item'} (HSN: ${item.hsn_code}, GST: ${item.gst_rate}%)`,
        quantity: item.quantity,
        unit_price: item.unit_cost,
        total_price: item.unit_cost * item.quantity,
        tax_rate: item.gst_rate,
        tax_amount: (item.unit_cost * item.quantity * item.gst_rate) / 100,
        service_type: 'Purchase',
        hsn_code: item.hsn_code
      })),
      subtotal: subtotal,
      tax: totalTax,
      total: total_amount,
      status: 'Issued',
      notes: `Purchase Order: ${purchaseOrder.order_number} - ${notes || ''}`,
    });

    await invoice.save();

    purchaseOrder.invoice_id = invoice._id;
    await purchaseOrder.save();

    const populatedPurchaseOrder = await PurchaseOrder.findById(purchaseOrder._id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');

    res.status(201).json({
      message: 'Purchase order created successfully',
      purchaseOrder: populatedPurchaseOrder,
      invoice: invoice,
      gst_summary: {
        subtotal,
        total_tax: totalTax,
        total_amount,
        cgst: totalTax / 2,
        sgst: totalTax / 2
      }
    });
  } catch (err) {
    console.error('Error creating purchase order:', err);
    res.status(400).json({ error: err.message });
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

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { received_items = [] } = req.body;

    if (!Array.isArray(received_items) || received_items.length === 0) {
      return res.status(400).json({
        error: 'received_items array is required',
      });
    }

    const order = await PurchaseOrder.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (!['Ordered', 'Partially Received'].includes(order.status)) {
      return res.status(400).json({
        error: `Cannot receive stock for order with status ${order.status}`,
      });
    }

    const createdBatches = [];

    for (const receivedItem of received_items) {
      const orderItem = order.items.id(receivedItem.item_id);

      if (!orderItem) {
        return res.status(400).json({
          error: `Purchase order item not found: ${receivedItem.item_id}`,
        });
      }

      const alreadyReceivedPacks = toNumber(orderItem.received, 0);
      const orderedPacks = toNumber(orderItem.quantity, 0);
      const pendingPacks = Math.max(0, orderedPacks - alreadyReceivedPacks);

      const receivedPacks = Math.max(
        0,
        toNumber(
          receivedItem.quantity_received_packs ??
          receivedItem.quantity_received,
          0
        )
      );

      if (receivedPacks <= 0) continue;

      if (receivedPacks > pendingPacks) {
        return res.status(400).json({
          error: `Cannot receive ${receivedPacks} packs for ${orderItem.medicine_name}. Pending quantity is ${pendingPacks} packs.`,
        });
      }

      const { medicine, unitsPerPack: medicineUnitsPerPack, hsnCode: medicineHsn, gstRate: medicineGst } = await getMedicineUnitInfo(orderItem.medicine_id);

      // ========== GST VALIDATION FOR RECEIVING ==========
      const hsnCode = orderItem.hsn_code || medicineHsn;
      const gstRate = orderItem.gst_rate !== undefined ? orderItem.gst_rate : medicineGst;

      if (!hsnCode) {
        return res.status(400).json({
          error: `HSN code is required for ${orderItem.medicine_name}. Please update the medicine master.`
        });
      }

      if (!validateHSNCode(hsnCode)) {
        return res.status(400).json({
          error: `Invalid HSN code "${hsnCode}" for ${orderItem.medicine_name}. HSN must be 4-8 digits.`
        });
      }

      if (gstRate === undefined || gstRate === null) {
        return res.status(400).json({
          error: `GST rate is required for ${orderItem.medicine_name}. Please update the medicine master.`
        });
      }

      if (!validateGSTRate(gstRate)) {
        return res.status(400).json({
          error: `Invalid GST rate ${gstRate}% for ${orderItem.medicine_name}. Valid rates: 0, 5, 12, 18, 28`
        });
      }

      const unitsPerPack = Math.max(
        1,
        toNumber(
          receivedItem.units_per_pack ??
          orderItem.units_per_pack ??
          medicineUnitsPerPack,
          medicineUnitsPerPack
        )
      );

      const quantityBaseUnits = Math.max(
        0,
        toNumber(
          receivedItem.quantity_received_base_units,
          receivedPacks * unitsPerPack
        )
      );

      const batchNumber = String(
        receivedItem.batch_number ||
        orderItem.batch_number ||
        ''
      ).trim();

      if (!batchNumber) {
        return res.status(400).json({
          error: `Batch number is required for ${orderItem.medicine_name}`,
        });
      }

      const expiryDate = receivedItem.expiry_date || orderItem.expiry_date;

      if (!expiryDate) {
        return res.status(400).json({
          error: `Expiry date is required for ${orderItem.medicine_name}`,
        });
      }

      const expiry = new Date(expiryDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (Number.isNaN(expiry.getTime()) || expiry <= today) {
        return res.status(400).json({
          error: `Expiry date must be a future date for ${orderItem.medicine_name}`,
        });
      }

      const purchasePricePerPack = roundMoney(
        receivedItem.purchase_price_per_pack ??
        receivedItem.purchase_price ??
        orderItem.unit_cost ??
        0
      );

      const sellingPricePerPack = roundMoney(
        receivedItem.selling_price_per_pack ??
        receivedItem.selling_price ??
        orderItem.selling_price ??
        medicine?.selling_price ??
        medicine?.price_per_unit ??
        purchasePricePerPack
      );

      const mrpPerPack = roundMoney(
        receivedItem.mrp_per_pack ??
        orderItem.mrp_per_pack ??
        medicine?.mrp ??
        sellingPricePerPack
      );

      const purchasePricePerBaseUnit = roundMoney(
        receivedItem.purchase_price_per_base_unit ??
        purchasePricePerPack / unitsPerPack
      );

      const sellingPricePerBaseUnit = roundMoney(
        receivedItem.selling_price_per_base_unit ??
        sellingPricePerPack / unitsPerPack
      );

      // Create batch with GST/HSN snapshot
      const batch = new MedicineBatch({
        medicine_id: orderItem.medicine_id,
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

        // ========== GST/HSN SNAPSHOT ==========
        hsn_code: hsnCode,
        gst_rate: gstRate,

        supplier_id: order.supplier_id,
        purchase_date: order.order_date || new Date(),
        received_date: new Date(),
        is_active: true,
      });

      await batch.save();
      createdBatches.push(batch);

      orderItem.received = alreadyReceivedPacks + receivedPacks;
      orderItem.batch_number = batchNumber;
      orderItem.expiry_date = expiry;
      orderItem.selling_price = sellingPricePerPack;
      orderItem.units_per_pack = unitsPerPack;
      orderItem.quantity_base_units = toNumber(orderItem.quantity_base_units, orderedPacks * unitsPerPack);
      orderItem.received_base_units = toNumber(orderItem.received_base_units, 0) + quantityBaseUnits;

      await Medicine.findByIdAndUpdate(orderItem.medicine_id, {
        $inc: { stock_quantity: quantityBaseUnits },
        $set: {
          units_per_pack: unitsPerPack,
        },
        // Optionally update medicine master if it's missing GST/HSN
        $setOnInsert: {
          hsn_code: hsnCode,
          gst_rate: gstRate
        },
      });
    }

    const totalOrderedPacks = order.items.reduce(
      (sum, item) => sum + toNumber(item.quantity, 0),
      0
    );

    const totalReceivedPacks = order.items.reduce(
      (sum, item) => sum + toNumber(item.received, 0),
      0
    );

    if (totalReceivedPacks <= 0) {
      order.status = 'Ordered';
    } else if (totalReceivedPacks < totalOrderedPacks) {
      order.status = 'Partially Received';
    } else {
      order.status = 'Received';
    }

    order.received_date = order.status === 'Received' ? new Date() : order.received_date;
    await order.save();

    const populatedOrder = await PurchaseOrder.findById(order._id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');

    res.json({
      message: 'Purchase order stock received successfully',
      order: populatedOrder,
      createdBatches,
      gst_summary: {
        total_batches: createdBatches.length,
        batches: createdBatches.map(b => ({
          batch_number: b.batch_number,
          medicine_name: order.items.find(i => i.medicine_id.toString() === b.medicine_id.toString())?.medicine_name,
          hsn_code: b.hsn_code,
          gst_rate: b.gst_rate,
          quantity: b.quantity_base_units
        }))
      }
    });
  } catch (err) {
    console.error('Error receiving purchase order:', err);
    res.status(400).json({
      error: 'Failed to receive purchase order',
      message: err.message,
    });
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
    
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    
    // Get return information if any
    const returns = sale.return_refs?.length > 0 
      ? await PharmacyReturn.find({ _id: { $in: sale.return_refs.map(r => r.return_id) } })
      : [];
    
    // Calculate GST summary for display
    const gstSummary = {
      subtotal: sale.subtotal || 0,
      total_tax: sale.tax || 0,
      total_amount: sale.total_amount || 0,
      cgst: (sale.tax || 0) / 2,
      sgst: (sale.tax || 0) / 2
    };
    
    res.json({
      success: true,
      sale,
      returns,
      gst_summary: gstSummary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateSalePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { additional_payment, payment_method, notes } = req.body;
    
    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    
    if (sale.status === 'Completed' && sale.balance_due === 0) {
      return res.status(400).json({ error: 'Sale is already fully paid' });
    }
    
    const newPaymentAmount = Math.min(additional_payment, sale.balance_due);
    const newPaidAmount = sale.amount_paid + newPaymentAmount;
    const newBalanceDue = sale.total_amount - newPaidAmount;
    
    sale.amount_paid = newPaidAmount;
    sale.balance_due = Math.max(0, newBalanceDue);
    sale.status = newBalanceDue === 0 ? 'Completed' : 'Pending';
    
    // Add payment to payments array
    sale.payments.push({
      method: payment_method,
      amount: newPaymentAmount,
      reference: req.body.reference,
      date: new Date()
    });
    
    await sale.save();
    
    // Create ledger entry for payment
    await PharmacyLedgerEntry.create({
      hospitalId: req.body.hospitalId || sale.hospitalId,
      pharmacyId: sale.pharmacy_id,
      entryType: 'OUTSTANDING_PAYMENT',
      direction: 'IN',
      amount: newPaymentAmount,
      paymentMethod: payment_method,
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      notes: notes || `Payment received for sale ${sale.sale_number}`,
      createdBy: req.user?._id
    });
    
    res.json({
      success: true,
      message: 'Payment recorded successfully',
      sale: {
        _id: sale._id,
        amount_paid: sale.amount_paid,
        balance_due: sale.balance_due,
        status: sale.status
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.voidSale = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    
    if (sale.status === 'Cancelled') {
      return res.status(400).json({ error: 'Sale is already cancelled' });
    }
    
    // Restore stock for each item
    for (const item of sale.items) {
      const batch = await MedicineBatch.findById(item.batch_id);
      if (batch) {
        batch.quantity_base_units += item.quantity_base_units;
        batch.quantity = batch.quantity_base_units;
        await batch.save();
        
        await Medicine.findByIdAndUpdate(item.medicine_id, {
          $inc: { stock_quantity: item.quantity_base_units }
        });
      }
    }
    
    sale.status = 'Cancelled';
    sale.notes = sale.notes + `\n[CANCELLED] ${new Date().toISOString()}: ${reason || 'No reason provided'}`;
    await sale.save();
    
    console.log(`Sale ${sale.sale_number} cancelled by ${req.user?.name} - Reason: ${reason}`);
    
    res.json({
      success: true,
      message: 'Sale cancelled successfully',
      sale: {
        _id: sale._id,
        sale_number: sale.sale_number,
        status: sale.status
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSalesByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { limit = 50, page = 1 } = req.query;
    
    const patient = await Patient.findById(patientId).select('first_name last_name patientId uhid');
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    
    const sales = await Sale.find({ patient_id: patientId })
      .populate('admission_id', 'admissionNumber shipNumber')
      .populate('doctor_id', 'firstName lastName')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .sort({ sale_date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Sale.countDocuments({ patient_id: patientId });
    
    res.json({
      success: true,
      patient,
      sales,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSalesByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId uhid');
    
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }
    
    const sales = await Sale.find({ admission_id: admissionId })
      .populate('doctor_id', 'firstName lastName')
      .populate('items.medicine_id', 'name hsn_code gst_rate')
      .populate('items.batch_id', 'batch_number expiry_date')
      .sort({ sale_date: -1 });
    
    // Calculate totals with GST
    const totals = sales.reduce((acc, sale) => {
      acc.totalAmount += sale.total_amount;
      acc.totalPaid += sale.amount_paid;
      acc.totalDue += sale.balance_due;
      acc.totalTax += sale.tax || 0;
      return acc;
    }, { totalAmount: 0, totalPaid: 0, totalDue: 0, totalTax: 0 });
    
    res.json({
      success: true,
      admission,
      sales,
      totals,
      gst_summary: {
        total_tax: totals.totalTax,
        cgst: totals.totalTax / 2,
        sgst: totals.totalTax / 2
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPendingPrescriptions = async (req, res) => {
  try {
    const { limit = 20, page = 1 } = req.query;
    
    const prescriptions = await Prescription.find({ 
      status: 'Active',
      $or: [
        { is_dispensed: false },
        { items: { $elemMatch: { is_dispensed: false } } }
      ]
    })
      .populate('patient_id', 'first_name last_name patientId uhid phone')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('items.medicine_id', 'name composition hsn_code gst_rate')
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Prescription.countDocuments({ 
      status: 'Active',
      is_dispensed: false
    });
    
    const prescriptionsWithCount = prescriptions.map(pres => {
      const undispensedItems = pres.items?.filter(item => !item.is_dispensed).length || 0;
      return {
        ...pres.toObject(),
        undispensedItemsCount: undispensedItems,
        totalItems: pres.items?.length || 0
      };
    });
    
    res.json({
      success: true,
      prescriptions: prescriptionsWithCount,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      .limit(parseInt(limit))
      .lean();
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todaySales = await Sale.aggregate([
      { $match: { sale_date: { $gte: todayStart } } },
      { $group: { _id: null, total: { $sum: '$total_amount' }, tax: { $sum: '$tax' }, count: { $sum: 1 } } }
    ]);
    
    res.json({
      success: true,
      recentSales,
      todayStats: {
        total: todaySales[0]?.total || 0,
        tax: todaySales[0]?.tax || 0,
        count: todaySales[0]?.count || 0,
        cgst: (todaySales[0]?.tax || 0) / 2,
        sgst: (todaySales[0]?.tax || 0) / 2
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== EXISTING SALE FUNCTIONS ==========

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
    const targetDate = date ? new Date(date) : new Date();

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
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;

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
    const targetYear = parseInt(year) || new Date().getFullYear();

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

    const currentDate = new Date();
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