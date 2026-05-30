const Invoice = require('../models/Invoice');
const PurchaseOrder = require('../models/PurchaseOrder');
const Sale = require('../models/Sale');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const { createUnifiedSale } = require('../services/pharmacyTransaction.service');

// ========== HELPER FUNCTIONS ==========
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMoney = (value) => {
  return Number(toNumber(value).toFixed(4));
};

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
    'units_per_pack pack_unit base_unit mrp selling_price price_per_unit'
  );
  return {
    medicine,
    unitsPerPack: Math.max(1, toNumber(medicine?.units_per_pack, 1)),
  };
};

// ========== PURCHASE ORDER FUNCTIONS ==========

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, items, notes, expected_delivery } = req.body;

    const subtotal = items.reduce((sum, item) => sum + (item.unit_cost * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total_amount = subtotal + tax;

    const purchaseOrder = new PurchaseOrder({
      supplier_id,
      items,
      subtotal,
      tax,
      total_amount,
      notes,
      expected_delivery: expected_delivery ? new Date(expected_delivery) : null,
      status: 'Ordered',
    });
    
    await purchaseOrder.save();

    const invoice = new Invoice({
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: 'Supplier Purchase',
      purchase_order_id: purchaseOrder._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      service_items: items.map(item => ({
        description: `Purchase - ${item.medicine_name || 'Item'}`,
        quantity: item.quantity,
        unit_price: item.unit_cost,
        total_price: item.unit_cost * item.quantity,
        service_type: 'Purchase'
      })),
      subtotal: subtotal,
      tax: tax,
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
      invoice: invoice
    });
  } catch (err) {
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
          error: `Cannot receive ${receivedPacks} packs for ${orderItem.medicine_id}. Pending quantity is ${pendingPacks} packs.`,
        });
      }

      const { medicine, unitsPerPack: medicineUnitsPerPack } = await getMedicineUnitInfo(orderItem.medicine_id);

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
          error: `Batch number is required for ${medicine?.name || orderItem.medicine_id}`,
        });
      }

      const expiryDate = receivedItem.expiry_date || orderItem.expiry_date;

      if (!expiryDate) {
        return res.status(400).json({
          error: `Expiry date is required for ${medicine?.name || orderItem.medicine_id}`,
        });
      }

      const expiry = new Date(expiryDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (Number.isNaN(expiry.getTime()) || expiry <= today) {
        return res.status(400).json({
          error: `Expiry date must be a future date for ${medicine?.name || orderItem.medicine_id}`,
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
    });
  } catch (err) {
    console.error('Error receiving purchase order:', err);
    res.status(400).json({
      error: 'Failed to receive purchase order',
      message: err.message,
    });
  }
};

// ========== SALES FUNCTIONS ==========

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

exports.createSale = async (req, res) => {
  try {
    if (process.env.USE_LEGACY_SALE !== 'true') {
      const result = await createUnifiedSale(req.body, req);
      return res.status(201).json({
        success: true,
        message: 'Sale created successfully',
        ...result,
        sale: result.sale,
        invoice: result.invoice
      });
    }
    
    const { 
      items, 
      patient_id, 
      customer_name, 
      customer_phone, 
      payment_method, 
      prescription_id,
      discount = 0,
      discount_type = 'percentage',
      tax_rate = 0,
      notes = '',
      subtotal,
      discount_amount,
      tax_amount,
      total_amount
    } = req.body;
    
    console.log('Sale request body:', req.body);
    
    for (const item of items) {
      const batch = await MedicineBatch.findById(item.batch_id);
      if (!batch) {
        return res.status(400).json({ 
          error: `Batch not found for ${item.medicine_name}` 
        });
      }
      
      if (batch.quantity < item.quantity) {
        return res.status(400).json({ 
          error: `Insufficient stock for ${item.medicine_name}. Available: ${batch.quantity}, Requested: ${item.quantity}` 
        });
      }
      
      batch.quantity -= item.quantity;
      await batch.save();
      
      await Medicine.findByIdAndUpdate(
        item.medicine_id,
        { $inc: { stock_quantity: -item.quantity } }
      );
    }

    const calculatedSubtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    
    let calculatedDiscount = 0;
    if (discount_type === 'percentage') {
      calculatedDiscount = calculatedSubtotal * (discount / 100);
    } else {
      calculatedDiscount = Math.min(discount, calculatedSubtotal);
    }
    
    const afterDiscount = calculatedSubtotal - calculatedDiscount;
    const calculatedTax = afterDiscount * (tax_rate / 100);
    const calculatedTotal = afterDiscount + calculatedTax;
    
    const tolerance = 0.01;
    if (Math.abs(calculatedSubtotal - parseFloat(subtotal)) > tolerance ||
        Math.abs(calculatedDiscount - parseFloat(discount_amount)) > tolerance ||
        Math.abs(calculatedTax - parseFloat(tax_amount)) > tolerance ||
        Math.abs(calculatedTotal - parseFloat(total_amount)) > tolerance) {
      console.warn('Frontend and backend calculations differ:', {
        frontend: { subtotal, discount_amount, tax_amount, total_amount },
        backend: { calculatedSubtotal, calculatedDiscount, calculatedTax, calculatedTotal }
      });
    }

    const invoiceNumber = await generateInvoiceNumber();
    
    const sale = new Sale({
      items,
      patient_id: patient_id || null,
      customer_name,
      customer_phone,
      subtotal: calculatedSubtotal,
      discount,
      discount_type,
      discount_amount: calculatedDiscount,
      tax_rate,
      tax: calculatedTax,
      total_amount: calculatedTotal,
      payment_method,
      prescription_id: prescription_id || null,
      notes,
      invoice_number: invoiceNumber,
    });
    
    await sale.save();

    if (prescription_id) {
      await Prescription.findByIdAndUpdate(prescription_id, { 
        status: 'Completed',
        last_dispensed: new Date()
      });

      const prescription = await Prescription.findById(prescription_id);
      if (prescription && prescription.items) {
        const updatedItems = prescription.items.map(item => {
          const saleItem = items.find(si => 
            si.medicine_name === item.medicine_name || 
            si.prescription_item?._id?.toString() === item._id.toString()
          );
          if (saleItem) {
            return {
              ...item.toObject(),
              is_dispensed: true,
              dispensed_quantity: saleItem.quantity,
              dispensed_date: new Date()
            };
          }
          return item;
        });

        await Prescription.findByIdAndUpdate(prescription_id, {
          items: updatedItems
        });
      }
    }

    const invoice = new Invoice({
      invoice_number: invoiceNumber,
      invoice_type: 'Pharmacy',
      patient_id: patient_id || null,
      customer_type: patient_id ? 'Patient' : 'Walk-in',
      customer_name,
      customer_phone,
      sale_id: sale._id,
      prescription_id: prescription_id || null,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      medicine_items: items.map(item => ({
        medicine_id: item.medicine_id,
        batch_id: item.batch_id,
        medicine_name: item.medicine_name,
        batch_number: item.batch_number,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.unit_price * item.quantity,
        tax_rate: tax_rate,
        tax_amount: (item.unit_price * item.quantity) * (tax_rate / 100)
      })),
      subtotal: calculatedSubtotal,
      discount: discount,
      discount_type: discount_type,
      discount_amount: calculatedDiscount,
      tax_rate: tax_rate,
      tax_amount: calculatedTax,
      total: calculatedTotal,
      status: payment_method === 'Pending' ? 'Pending' : 'Paid',
      payment_method: payment_method,
      amount_paid: payment_method === 'Pending' ? 0 : calculatedTotal,
      balance_due: payment_method === 'Pending' ? calculatedTotal : 0,
      is_pharmacy_sale: true,
      dispensing_date: new Date(),
      notes: notes,
    });

    await invoice.save();

    sale.invoice_id = invoice._id;
    await sale.save();

    const populatedSale = await Sale.findById(sale._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('items.medicine_id', 'name mrp')
      .populate('items.batch_id', 'batch_number expiry_date')
      .lean();

    res.status(201).json({
      message: 'Sale created successfully',
      sale: {
        ...populatedSale,
        invoice_id: invoice._id,
        invoice_number: invoiceNumber
      },
      invoice: {
        _id: invoice._id,
        invoice_number: invoiceNumber,
        total: invoice.total,
        status: invoice.status
      }
    });
  } catch (err) {
    console.error('Error creating sale:', err);
    res.status(400).json({ 
      error: 'Failed to create sale',
      message: err.message 
    });
  }
};

exports.getAllSales = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 10 } = req.query;
    
    const filter = {};
    if (startDate && endDate) {
      filter.sale_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const sales = await Sale.find(filter)
      .populate('patient_id')
      .populate('items.medicine_id')
      .populate('items.batch_id')
      .populate('created_by', 'name')
      .sort({ sale_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Sale.countDocuments(filter);
    
    res.json({
      sales,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
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
    .populate('items.medicine_id', 'name')
    .sort({ sale_date: -1 });

    res.json({
      date: targetDate.toISOString().split('T')[0],
      summary: dailyStats[0] || {
        totalSales: 0,
        totalRevenue: 0,
        averageSale: 0,
        paymentMethods: []
      },
      sales: dailySales
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
          dailyRevenue: { $sum: '$total_amount' }
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
        averageDailySales: 0,
        averageDailyRevenue: 0,
        bestDay: 0,
        worstDay: 0,
        daysWithSales: 0
      },
      topMedicines
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
          monthlyRevenue: { $sum: '$total_amount' }
        }
      },
      {
        $group: {
          _id: {
            year: '$_id.year'
          },
          totalSales: { $sum: '$monthlySales' },
          totalRevenue: { $sum: '$monthlyRevenue' },
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
          revenue: { $sum: '$total_amount' }
        }
      },
      { $sort: { '_id.month': 1 } }
    ]);

    res.json({
      year: targetYear,
      summary: yearlyStats[0] || {
        totalSales: 0,
        totalRevenue: 0,
        averageMonthlySales: 0,
        averageMonthlyRevenue: 0,
        bestMonth: 0,
        worstMonth: 0,
        monthsWithSales: 0
      },
      monthlyBreakdown
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      averageOrderValue: 0,
      statusBreakdown: []
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
            salesCount: { $sum: 1 }
          }
        }
      ])
    ]);

    const current = currentStats[0] || { revenue: 0, salesCount: 0 };
    const previous = previousStats[0] || { revenue: 0, salesCount: 0 };

    const revenueGrowth = previous.revenue > 0 
      ? ((current.revenue - previous.revenue) / previous.revenue) * 100 
      : current.revenue > 0 ? 100 : 0;

    const salesGrowth = previous.salesCount > 0 
      ? ((current.salesCount - previous.salesCount) / previous.salesCount) * 100 
      : current.salesCount > 0 ? 100 : 0;

    res.json({
      currentPeriod: {
        revenue: current.revenue,
        salesCount: current.salesCount,
        period: period === 'month' ? currentDate.toLocaleString('default', { month: 'long', year: 'numeric' }) : currentDate.getFullYear().toString()
      },
      previousPeriod: {
        revenue: previous.revenue,
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