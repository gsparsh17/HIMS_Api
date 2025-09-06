const Invoice = require('../models/Invoice');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const PDFDocument = require('pdfkit');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');

// Generate pharmacy invoice with stock management
exports.generatePharmacyInvoice = async (req, res) => {
  try {
    const { prescription_id, patient_id, items, discount = 0, notes, payment_method } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Invoice must contain at least one item.' });
    }

    // Calculate totals
    const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total = subtotal + tax - discount;

    // Create invoice
    const invoice = new Invoice({
      invoice_type: 'Pharmacy',
      patient_id: patient_id,
      customer_type: 'Patient',
      medicine_items: items,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      total: total,
      status: 'Issued',
      payment_method: payment_method,
      notes: notes,
      is_pharmacy_sale: true,
      created_by: req.user._id,
      dispensing_date: new Date(),
      dispensed_by: req.user._id
    });

    const createdInvoice = await invoice.save();

    // Update stock quantities
    for (const item of items) {
      await Medicine.findByIdAndUpdate(
        item.medicine_id,
        { $inc: { stock_quantity: -item.quantity } }
      );
    }

    // Delete prescription if provided
    if (prescription_id) {
      await Prescription.findByIdAndDelete(prescription_id);
    }

    // Populate response
    const populatedInvoice = await Invoice.findById(createdInvoice._id)
      .populate('patient_id')
      .populate('medicine_items.medicine_id');

    res.status(201).json({
      message: 'Pharmacy invoice created successfully',
      invoice: populatedInvoice
    });

  } catch (err) {
    console.error('Error generating pharmacy invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Download invoice PDF
exports.downloadInvoicePDF = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('patient_id')
      .populate('medicine_items.medicine_id')
      .populate('service_items');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const doc = new PDFDocument({ margin: 50 });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoice_number}.pdf`);

    doc.pipe(res);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text('MEDICAL INVOICE', { align: 'center' });
    doc.moveDown();

    // Invoice Details
    doc.fontSize(12).font('Helvetica');
    doc.text(`Invoice Number: ${invoice.invoice_number}`);
    doc.text(`Type: ${invoice.invoice_type}`);
    doc.text(`Date: ${new Date(invoice.issue_date).toLocaleDateString()}`);
    doc.text(`Status: ${invoice.status}`);
    doc.moveDown();

    // Customer Details
    if (invoice.patient_id) {
      doc.text(`Patient: ${invoice.patient_id.first_name} ${invoice.patient_id.last_name}`);
      doc.text(`Phone: ${invoice.patient_id.phone}`);
    } else {
      doc.text(`Customer: ${invoice.customer_name}`);
      doc.text(`Phone: ${invoice.customer_phone}`);
    }
    doc.moveDown(2);

    // Items Table Header
    const tableTop = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('Description', 50, tableTop);
    doc.text('Qty', 250, tableTop, { width: 60, align: 'right' });
    doc.text('Price', 320, tableTop, { width: 80, align: 'right' });
    doc.text('Total', 410, tableTop, { width: 80, align: 'right' });
    
    doc.moveDown();
    doc.font('Helvetica');

    // Medicine Items
    if (invoice.medicine_items && invoice.medicine_items.length > 0) {
      doc.font('Helvetica-Bold').text('MEDICINES:').font('Helvetica');
      invoice.medicine_items.forEach(item => {
        const y = doc.y;
        const medicineName = item.medicine_id ? item.medicine_id.name : item.medicine_name;
        doc.text(medicineName, 50, y);
        doc.text(item.quantity.toString(), 250, y, { width: 60, align: 'right' });
        doc.text(`₹${item.unit_price.toFixed(2)}`, 320, y, { width: 80, align: 'right' });
        doc.text(`₹${(item.unit_price * item.quantity).toFixed(2)}`, 410, y, { width: 80, align: 'right' });
        doc.moveDown();
      });
    }

    // Service Items
    if (invoice.service_items && invoice.service_items.length > 0) {
      doc.font('Helvetica-Bold').text('SERVICES:').font('Helvetica');
      invoice.service_items.forEach(item => {
        const y = doc.y;
        doc.text(item.description, 50, y);
        doc.text(item.quantity.toString(), 250, y, { width: 60, align: 'right' });
        doc.text(`₹${item.unit_price.toFixed(2)}`, 320, y, { width: 80, align: 'right' });
        doc.text(`₹${item.total_price.toFixed(2)}`, 410, y, { width: 80, align: 'right' });
        doc.moveDown();
      });
    }

    // Totals
    doc.moveDown();
    doc.font('Helvetica-Bold');
    doc.text(`Subtotal: ₹${invoice.subtotal.toFixed(2)}`, 320, doc.y, { width: 80, align: 'right' });
    doc.text(`Discount: ₹${invoice.discount.toFixed(2)}`, 320, doc.y + 20, { width: 80, align: 'right' });
    doc.text(`Tax: ₹${invoice.tax.toFixed(2)}`, 320, doc.y + 40, { width: 80, align: 'right' });
    doc.text(`Total: ₹${invoice.total.toFixed(2)}`, 320, doc.y + 60, { width: 80, align: 'right' });
    
    // Payment Info
    doc.moveDown(3);
    doc.font('Helvetica');
    doc.text(`Amount Paid: ₹${invoice.amount_paid.toFixed(2)}`);
    doc.text(`Balance Due: ₹${invoice.balance_due.toFixed(2)}`);
    if (invoice.payment_history.length > 0) {
      doc.text(`Payment Method: ${invoice.payment_history[0].method}`);
    }

    doc.end();

  } catch (err) {
    console.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Could not generate PDF' });
  }
};

// Get pharmacy invoices specifically
exports.getPharmacyInvoices = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    
    const filter = { invoice_type: 'Pharmacy' };
    if (status) filter.status = status;

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('medicine_items.medicine_id', 'name')
      .populate('dispensed_by', 'name')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    res.json({
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get monthly revenue for pharmacy
exports.getPharmacyMonthlyRevenue = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const result = await Invoice.aggregate([
      {
        $match: {
          invoice_type: 'Pharmacy',
          status: 'Paid',
          issue_date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          totalInvoices: { $sum: 1 }
        }
      }
    ]);

    const totalRevenue = result.length > 0 ? result[0].totalRevenue : 0;
    const totalInvoices = result.length > 0 ? result[0].totalInvoices : 0;

    res.json({ totalRevenue, totalInvoices });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update stock when pharmacy invoice is created
exports.updateMedicineStock = async (medicineId, quantity) => {
  try {
    await Medicine.findByIdAndUpdate(
      medicineId,
      { $inc: { stock_quantity: -quantity } },
      { new: true }
    );
  } catch (err) {
    console.error('Error updating stock:', err);
    throw err;
  }
};
// Generate invoice for appointment
exports.generateAppointmentInvoice = async (req, res) => {
  try {
    const { appointment_id, payment_method, items, discount = 0, notes } = req.body;

    const appointment = await Appointment.findById(appointment_id)
      .populate('patient_id')
      .populate('doctor_id');

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total = subtotal + tax - discount;

    const invoice = new Invoice({
      invoice_type: 'Appointment',
      patient_id: appointment.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${appointment.patient_id.first_name} ${appointment.patient_id.last_name}`,
      customer_phone: appointment.patient_id.phone,
      appointment_id: appointment_id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      service_items: items,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      total: total,
      status: 'Issued',
      notes: notes,
      created_by: req.user._id
    });

    await invoice.save();

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id')
      .populate('appointment_id');

    res.status(201).json({
      message: 'Appointment invoice generated successfully',
      invoice: populatedInvoice
    });

  } catch (err) {
    console.error('Error generating appointment invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Generate invoice for pharmacy sale
exports.generatePharmacyInvoice = async (req, res) => {
  try {
    const { sale_id, patient_id, customer_name, customer_phone, items, discount = 0, notes } = req.body;

    const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total = subtotal + tax - discount;

    const invoice = new Invoice({
      invoice_type: 'Pharmacy',
      patient_id: patient_id,
      customer_type: patient_id ? 'Patient' : 'Walk-in',
      customer_name: customer_name,
      customer_phone: customer_phone,
      sale_id: sale_id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      medicine_items: items,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      total: total,
      status: 'Issued',
      notes: notes,
      created_by: req.user._id,
      is_pharmacy_sale: true
    });

    await invoice.save();

    // Create or update sale record
    if (sale_id) {
      await Sale.findByIdAndUpdate(sale_id, { invoice_id: invoice._id });
    } else {
      const sale = new Sale({
        patient_id: patient_id,
        customer_name: customer_name,
        customer_phone: customer_phone,
        items: items.map(item => ({
          medicine_id: item.medicine_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.unit_price * item.quantity,
          discount: item.discount || 0
        })),
        subtotal: subtotal,
        discount: discount,
        tax: tax,
        total_amount: total,
        payment_method: 'Pending', // Will be updated when payment is made
        invoice_id: invoice._id
      });
      await sale.save();
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id')
      .populate('sale_id');

    res.status(201).json({
      message: 'Pharmacy invoice generated successfully',
      invoice: populatedInvoice
    });

  } catch (err) {
    console.error('Error generating pharmacy invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Generate purchase order invoice (for internal accounting)
exports.generatePurchaseInvoice = async (req, res) => {
  try {
    const { purchase_order_id, supplier_id, items, notes } = req.body;

    const supplier = await Supplier.findById(supplier_id);
    if (!supplier) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const subtotal = items.reduce((sum, item) => sum + (item.unit_cost * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total = subtotal + tax;

    const invoice = new Invoice({
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: supplier.name,
      customer_phone: supplier.phone,
      customer_address: supplier.address,
      purchase_order_id: purchase_order_id,
      issue_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days for suppliers
      service_items: items.map(item => ({
        description: `Purchase - ${item.medicine_name || 'Item'}`,
        quantity: item.quantity,
        unit_price: item.unit_cost,
        total_price: item.unit_cost * item.quantity,
        service_type: 'Purchase'
      })),
      subtotal: subtotal,
      tax: tax,
      total: total,
      status: 'Issued',
      notes: notes,
      created_by: req.user._id
    });

    await invoice.save();

    // Create or update purchase order
    if (purchase_order_id) {
      await PurchaseOrder.findByIdAndUpdate(purchase_order_id, { 
        invoice_id: invoice._id,
        status: 'Ordered'
      });
    } else {
      const purchaseOrder = new PurchaseOrder({
        supplier_id: supplier_id,
        items: items,
        subtotal: subtotal,
        tax: tax,
        total_amount: total,
        invoice_id: invoice._id,
        status: 'Ordered',
        created_by: req.user._id
      });
      await purchaseOrder.save();
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('purchase_order_id');

    res.status(201).json({
      message: 'Purchase invoice generated successfully',
      invoice: populatedInvoice
    });

  } catch (err) {
    console.error('Error generating purchase invoice:', err);
    res.status(400).json({ error: err.message });
  }
};
// Get all invoices with filters
exports.getAllInvoices = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      invoice_type, 
      patient_id,
      customer_type,
      startDate,
      endDate 
    } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (invoice_type) filter.invoice_type = invoice_type;
    if (patient_id) filter.patient_id = patient_id;
    if (customer_type) filter.customer_type = customer_type;
    
    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('sale_id', 'sale_number sale_date')
      .populate('purchase_order_id', 'order_number order_date')
      .populate('created_by', 'name')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    res.json({
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get invoice by ID
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('patient_id')
      .populate('appointment_id')
      .populate('sale_id')
      .populate('purchase_order_id')
      .populate('created_by', 'name');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update invoice payment
exports.updateInvoicePayment = async (req, res) => {
  try {
    const { amount, method, reference, collected_by } = req.body;

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Add payment to history
    invoice.payment_history.push({
      amount: amount,
      method: method,
      reference: reference,
      collected_by: collected_by,
      date: new Date()
    });

    // Update amounts
    invoice.amount_paid += amount;
    invoice.balance_due = invoice.total - invoice.amount_paid;

    // Update status based on payment
    if (invoice.amount_paid >= invoice.total) {
      invoice.status = 'Paid';
      
      // Update related sale status if exists
      if (invoice.sale_id) {
        await Sale.findByIdAndUpdate(invoice.sale_id, { 
          status: 'Completed',
          payment_method: method
        });
      }
      
    } else if (invoice.amount_paid > 0) {
      invoice.status = 'Partial';
    }

    await invoice.save();

    res.json({
      message: 'Payment updated successfully',
      invoice: await Invoice.findById(invoice._id)
        .populate('patient_id')
        .populate('sale_id')
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get invoices by type
exports.getInvoicesByType = async (req, res) => {
  try {
    const { type } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const filter = { invoice_type: type };
    if (status) filter.status = status;

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('sale_id', 'sale_number')
      .populate('purchase_order_id', 'order_number')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    res.json({
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get invoice statistics
exports.getInvoiceStatistics = async (req, res) => {
  try {
    const { startDate, endDate, type } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    if (type) filter.invoice_type = type;

    const totalInvoices = await Invoice.countDocuments(filter);
    
    const totalRevenue = await Invoice.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    
    const paidRevenue = await Invoice.aggregate([
      { $match: { ...filter, status: 'Paid' } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);

    const revenueByType = await Invoice.aggregate([
      { $match: filter },
      { $group: { _id: '$invoice_type', total: { $sum: '$total' }, count: { $sum: 1 } } }
    ]);

    const statusCounts = await Invoice.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    res.json({
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      paidRevenue: paidRevenue[0]?.total || 0,
      pendingRevenue: (totalRevenue[0]?.total || 0) - (paidRevenue[0]?.total || 0),
      revenueByType,
      statusCounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Export invoices to CSV/Excel
exports.exportInvoices = async (req, res) => {
  try {
    const { startDate, endDate, type, status } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    if (type) filter.invoice_type = type;
    if (status) filter.status = status;

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('appointment_id', 'appointment_date type')
      .populate('sale_id', 'sale_number')
      .populate('purchase_order_id', 'order_number')
      .sort({ issue_date: -1 });

    // Simple CSV export (you can enhance this with proper CSV library)
    const csvData = invoices.map(invoice => ({
      'Invoice Number': invoice.invoice_number,
      'Type': invoice.invoice_type,
      'Customer': invoice.customer_name,
      'Date': invoice.issue_date.toISOString().split('T')[0],
      'Total': invoice.total,
      'Paid': invoice.amount_paid,
      'Balance': invoice.balance_due,
      'Status': invoice.status
    }));

    res.json(csvData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};