const Invoice = require('../models/Invoice');
const PurchaseOrder = require('../models/PurchaseOrder');
const Sale = require('../models/Sale');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');

// Purchase Order Functions
// exports.createPurchaseOrder = async (req, res) => {
//   try {
//     const purchaseOrder = new PurchaseOrder({
//       ...req.body,
//       created_by: req.user._id
//     });
    
//     await purchaseOrder.save();
//     res.status(201).json(purchaseOrder);
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

exports.getAllPurchaseOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    
    const orders = await PurchaseOrder.find(filter)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name')
      .sort({ order_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await PurchaseOrder.countDocuments(filter);
    
    res.json({
      orders,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.receivePurchaseOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { received_items } = req.body; // Array of { item_id, quantity_received, batch_number, expiry_date, selling_price }
    console.log('received_items:', req.body);
    const order = await PurchaseOrder.findById(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    for (const receivedItem of received_items) {
      const orderItem = order.items.id(receivedItem.item_id);
      if (orderItem) {
        // Create batch with received data
        const batch = new MedicineBatch({
          medicine_id: orderItem.medicine_id,
          batch_number: receivedItem.batch_number || orderItem.batch_number || '',
          expiry_date: receivedItem.expiry_date || orderItem.expiry_date,
          quantity: receivedItem.quantity_received || 0,
          purchase_price: orderItem.unit_cost,
          selling_price: receivedItem.selling_price || orderItem.selling_price || orderItem.unit_cost,
          supplier_id: order.supplier_id
        });
        await batch.save();
        
        // Update medicine stock
        await Medicine.findByIdAndUpdate(
          orderItem.medicine_id,
          { $inc: { stock_quantity: receivedItem.quantity_received || 0 } }
        );

        // Update order item with received quantity and details
        orderItem.received = (orderItem.received || 0) + (receivedItem.quantity_received || 0);
        // Update batch_number, expiry_date, selling_price in the order item if provided
        if (receivedItem.batch_number) orderItem.batch_number = receivedItem.batch_number;
        if (receivedItem.expiry_date) orderItem.expiry_date = receivedItem.expiry_date;
        if (receivedItem.selling_price) orderItem.selling_price = receivedItem.selling_price;
      }
    }
    
    order.status = 'Received';
    await order.save();
    
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Sales Functions
// exports.createSale = async (req, res) => {
//   try {
//     const { items, patient_id, customer_name, customer_phone, payment_method } = req.body;
    
//     // Check stock and deduct quantities
//     for (const item of items) {
//       const batch = await MedicineBatch.findById(item.batch_id);
//       if (!batch || batch.quantity < item.quantity) {
//         return res.status(400).json({ 
//           error: `Insufficient stock for batch ${batch?.batch_number}` 
//         });
//       }
      
//       batch.quantity -= item.quantity;
//       await batch.save();
      
//       // Update medicine total stock
//       await Medicine.findByIdAndUpdate(
//         item.medicine_id,
//         { $inc: { stock_quantity: -item.quantity } }
//       );
//     }
    
//     const sale = new Sale({
//       items,
//       patient_id,
//       customer_name,
//       customer_phone,
//       payment_method,
//       created_by: req.user._id
//     });
    
//     await sale.save();
//     res.status(201).json(sale);
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

exports.createPurchaseOrder = async (req, res) => {
  try {
    const { supplier_id, items, notes, expected_delivery } = req.body;

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.unit_cost * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total_amount = subtotal + tax;

    // Create purchase order
    const purchaseOrder = new PurchaseOrder({
      supplier_id,
      items,
      subtotal,
      tax,
      total_amount,
      notes,
      expected_delivery: expected_delivery ? new Date(expected_delivery) : null,
      status: 'Ordered',
      // created_by: user_id
    });
    
    await purchaseOrder.save();

    // Create invoice for the purchase order
    const invoice = new Invoice({
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: 'Supplier Purchase', // Will be populated from supplier data
      purchase_order_id: purchaseOrder._id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
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
      // created_by: user_id
    });

    await invoice.save();

    // Update purchase order with invoice reference
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

exports.getPurchaseOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await PurchaseOrder.findById(id)
      .populate('supplier_id')
      .populate('items.medicine_id')
      .populate('created_by', 'name');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Create sale with invoice generation
exports.createSale = async (req, res) => {
  try {
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
      subtotal, // From frontend calculation
      discount_amount, // From frontend calculation
      tax_amount, // From frontend calculation
      total_amount // From frontend calculation
    } = req.body;
    
    console.log('Sale request body:', req.body);
    
    // Validate all items have batches and sufficient stock
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
      
      // Update batch stock
      batch.quantity -= item.quantity;
      await batch.save();
      
      // Update medicine total stock
      await Medicine.findByIdAndUpdate(
        item.medicine_id,
        { $inc: { stock_quantity: -item.quantity } }
      );
    }

    // Validate totals match frontend calculations (optional security check)
    // You can choose to trust frontend or recalculate for security
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
    
    // Optional: Validate frontend calculations match backend calculations
    const tolerance = 0.01; // Allow small rounding differences
    if (Math.abs(calculatedSubtotal - parseFloat(subtotal)) > tolerance ||
        Math.abs(calculatedDiscount - parseFloat(discount_amount)) > tolerance ||
        Math.abs(calculatedTax - parseFloat(tax_amount)) > tolerance ||
        Math.abs(calculatedTotal - parseFloat(total_amount)) > tolerance) {
      
      console.warn('Frontend and backend calculations differ:', {
        frontend: { subtotal, discount_amount, tax_amount, total_amount },
        backend: { calculatedSubtotal, calculatedDiscount, calculatedTax, calculatedTotal }
      });
      
      // You can either:
      // 1. Use backend calculations (more secure):
      // subtotal = calculatedSubtotal;
      // discount_amount = calculatedDiscount;
      // tax_amount = calculatedTax;
      // total_amount = calculatedTotal;
      
      // 2. Or return error:
      // return res.status(400).json({ 
      //   error: 'Calculation mismatch detected. Please refresh and try again.' 
      // });
    }

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();
    
    // Create sale with all financial data
    const sale = new Sale({
      items,
      patient_id: patient_id || null,
      customer_name,
      customer_phone,
      subtotal: calculatedSubtotal, // Use backend calculation
      discount,
      discount_type,
      discount_amount: calculatedDiscount, // Use backend calculation
      tax_rate,
      tax: calculatedTax, // Use backend calculation
      total_amount: calculatedTotal, // Use backend calculation
      payment_method,
      prescription_id: prescription_id || null,
      notes,
      invoice_number: invoiceNumber,
      // created_by: req.user?._id
    });
    
    await sale.save();

    // Update prescription status if prescription exists
    if (prescription_id) {
      await Prescription.findByIdAndUpdate(prescription_id, { 
        status: 'Completed',
        last_dispensed: new Date()
      });

      // Mark prescription items as dispensed
      const prescription = await Prescription.findById(prescription_id);
      if (prescription && prescription.items) {
        const updatedItems = prescription.items.map(item => {
          // Check if this item was in the sale
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

    // Create invoice for the sale
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
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      medicine_items: items.map(item => ({
        medicine_id: item.medicine_id,
        batch_id: item.batch_id,
        medicine_name: item.medicine_name,
        batch_number: item.batch_number,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.unit_price * item.quantity,
        tax_rate: tax_rate, // Apply same tax rate to all items
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
      // dispensed_by: req.user._id,
      // created_by: req.user._id
    });

    await invoice.save();

    // Update sale with invoice reference
    sale.invoice_id = invoice._id;
    await sale.save();

    // Populate sale with related data
    const populatedSale = await Sale.findById(sale._id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('items.medicine_id', 'name mrp')
      .populate('items.batch_id', 'batch_number expiry_date')
      // .populate('prescription_id', 'prescription_number')
      // .populate('created_by', 'name')
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

// Helper function to generate invoice number
async function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  
  // Get the last invoice number for this month
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

// Get sales statistics
exports.getSalesStatistics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const filter = {};
    if (startDate && endDate) {
      filter.sale_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const stats = await Sale.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalSales: { $sum: 1 },
          totalRevenue: { $sum: '$total_amount' },
          averageSale: { $avg: '$total_amount' }
        }
      }
    ]);
    
    res.json(stats[0] || { totalSales: 0, totalRevenue: 0, averageSale: 0 });
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

// Get daily sales report
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

    // Get individual sales for the day
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

// Get monthly sales report
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

    // Get top selling medicines for the month
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

// Get yearly sales report
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

    // Monthly breakdown
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

// Get purchase order statistics
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

// Get revenue comparison (year over year, month over month)
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
    } else { // year
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