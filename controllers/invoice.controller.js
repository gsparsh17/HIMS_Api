const Invoice = require('../models/Invoice');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const PDFDocument = require('pdfkit');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const Hospital = require('../models/Hospital');
const Pharmacy = require('../models/Pharmacy');

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

exports.downloadInvoicePDF = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch invoice with populated data
    const invoice = await Invoice.findById(id)
      .populate('patient_id', 'first_name last_name phone address')
      .populate('medicine_items.medicine_id', 'name generic_name')
      .populate('medicine_items.batch_id', 'batch_number expiry_date');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Fetch hospital and pharmacy details
    const hospital = await Hospital.findOne(); // Get first hospital
    const pharmacy = await Pharmacy.findOne(); // Get first pharmacy

    // Create PDF document
    const doc = new PDFDocument({ margin: 50 });
    
    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);

    // Pipe PDF to response
    doc.pipe(res);

    // Add hospital and pharmacy header
    addHeader(doc, hospital, pharmacy);

    // Add invoice details
    addInvoiceDetails(doc, invoice);

    // Add customer/patient details
    addCustomerDetails(doc, invoice);

    // Add items table
    addItemsTable(doc, invoice);

    // Add totals and footer
    addFooter(doc, invoice);

    // Finalize PDF
    doc.end();

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
};

function addHeader(doc, hospital, pharmacy) {
  // Hospital details (left side)
  doc.fontSize(16).font('Helvetica-Bold').text(hospital?.hospitalName || 'Hospital Name', 50, 50);
  doc.fontSize(10).font('Helvetica');
  doc.text(hospital?.address || 'Hospital Address', 50, 70);
  doc.text(`Phone: ${hospital?.contact || 'N/A'} | Email: ${hospital?.email || 'N/A'}`, 50, 85);
  doc.text(`Registry No: ${hospital?.registryNo || 'N/A'}`, 50, 100);

  // Pharmacy details (right side)
  const rightMargin = 350;
  doc.fontSize(14).font('Helvetica-Bold').text(pharmacy?.name || 'Pharmacy', rightMargin, 50, { align: 'right' });
  doc.fontSize(10).font('Helvetica');
  doc.text(`License: ${pharmacy?.licenseNumber || 'N/A'}`, rightMargin, 70, { align: 'right' });
  doc.text(pharmacy?.address || 'Pharmacy Address', rightMargin, 85, { align: 'right' });
  doc.text(`Phone: ${pharmacy?.phone || 'N/A'} | Email: ${pharmacy?.email || 'N/A'}`, rightMargin, 100, { align: 'right' });

  // Separator line
  doc.moveTo(50, 120).lineTo(550, 120).stroke();
}

function addInvoiceDetails(doc, invoice) {
  doc.fontSize(12).font('Helvetica-Bold').text('TAX INVOICE', 50, 140);
  
  // Invoice details in two columns
  const leftCol = 50;
  const rightCol = 300;
  let y = 160;

  doc.fontSize(10).font('Helvetica');
  doc.text('Invoice Number:', leftCol, y);
  doc.text(invoice.invoice_number, leftCol + 100, y);

  doc.text('Invoice Date:', rightCol, y);
  doc.text(new Date(invoice.issue_date).toLocaleDateString(), rightCol + 80, y);
  y += 20;

  doc.text('Due Date:', rightCol, y);
  doc.text(new Date(invoice.due_date).toLocaleDateString(), rightCol + 80, y);
  y += 30;
}

function addCustomerDetails(doc, invoice) {
  doc.fontSize(11).font('Helvetica-Bold').text('Customer Details:', 50, 220);
  
  let y = 240;
  doc.fontSize(10).font('Helvetica');
  
  if (invoice.patient_id) {
    doc.text(`Name: ${invoice.patient_id.first_name} ${invoice.patient_id.last_name}`, 50, y);
    y += 15;
    doc.text(`Phone: ${invoice.patient_id.phone || 'N/A'}`, 50, y);
    y += 15;
    doc.text(`Address: ${invoice.patient_id.address || 'N/A'}`, 50, y);
  } else {
    doc.text(`Name: ${invoice.customer_name || 'N/A'}`, 50, y);
    y += 15;
    doc.text(`Phone: ${invoice.customer_phone || 'N/A'}`, 50, y);
  }
  y += 20;
}

function addItemsTable(doc, invoice) {
  const tableTop = 300;
  const itemCodeX = 50;
  const descriptionX = 100;
  const quantityX = 350;
  const priceX = 400;
  const amountX = 470;

  // Table headers
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('Code', itemCodeX, tableTop);
  doc.text('Description', descriptionX, tableTop);
  doc.text('Qty', quantityX, tableTop);
  doc.text('Price', priceX, tableTop);
  doc.text('Amount', amountX, tableTop);

  // Draw header line
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  // Medicine items
  invoice.medicine_items.forEach((item, index) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    doc.text(item.batch_id?.batch_number.slice(-4) || 'N/A', itemCodeX, y);
    doc.text(`${item.medicine_name}${item.batch_id ? ` (Batch: ${item.batch_id.batch_number})` : ''}`, descriptionX, y, { width: 240 });
    doc.text(item.quantity.toString(), quantityX, y);
    doc.text(`₹${item.unit_price.toFixed(2)}`, priceX, y);
    doc.text(`₹${item.total_price.toFixed(2)}`, amountX, y);
    
    y += 20;
  });

  // Service items
  invoice.service_items.forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    doc.text('SRV', itemCodeX, y);
    doc.text(item.description, descriptionX, y, { width: 240 });
    doc.text(item.quantity.toString(), quantityX, y);
    doc.text(`₹${item.unit_price.toFixed(2)}`, priceX, y);
    doc.text(`₹${item.total_price.toFixed(2)}`, amountX, y);
    
    y += 20;
  });

  return y;
}

function addFooter(doc, invoice) {
  const footerY = 650;
  
  // Summary
  doc.fontSize(10).font('Helvetica');
  doc.text(`Subtotal: ₹${invoice.subtotal.toFixed(2)}`, 400, footerY, { align: 'right' });
  doc.text(`Tax: ₹${invoice.tax.toFixed(2)}`, 400, footerY + 15, { align: 'right' });
  if (invoice.discount > 0) {
    doc.text(`Discount: -₹${invoice.discount.toFixed(2)}`, 400, footerY + 30, { align: 'right' });
  }
  doc.fontSize(11).font('Helvetica-Bold');
  doc.text(`Total: ₹${invoice.total.toFixed(2)}`, 400, footerY + 45, { align: 'right' });
  
  doc.fontSize(10).font('Helvetica');
  doc.text(`Amount Paid: ₹${invoice.amount_paid.toFixed(2)}`, 400, footerY + 65, { align: 'right' });
  doc.text(`Balance Due: ₹${invoice.balance_due.toFixed(2)}`, 400, footerY + 80, { align: 'right' });

  // Status
  doc.text(`Status: ${invoice.status}`, 50, footerY + 80);
  
  // Footer note
  doc.fontSize(8).text('Thank you for your business!', 50, 750, { align: 'center' });
  doc.text('This is a computer generated invoice and does not require a physical signature.', 50, 765, { align: 'center' });
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
      // .populate('purchase_order_id', 'order_number order_date')
      // .populate('created_by', 'name')
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
      // .populate('purchase_order_id')
      // .populate('created_by', 'name');

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