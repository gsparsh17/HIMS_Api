const Invoice = require('../models/Invoice');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const Hospital = require('../models/Hospital');
const Pharmacy = require('../models/Pharmacy');
const Bill = require('../models/Bill');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Generate invoice for procedures
exports.generateProcedureInvoice = async (req, res) => {
  try {
    const {
      prescription_id,
      patient_id,
      appointment_id,
      procedures,
      additional_services = [],
      discount = 0,
      notes,
      payment_method
    } = req.body;

    if (!procedures || procedures.length === 0) {
      return res.status(400).json({
        message: 'Invoice must contain at least one procedure.'
      });
    }

    // Calculate totals
    const procedureSubtotal = procedures.reduce((sum, proc) =>
      sum + (proc.unit_price * proc.quantity), 0);

    const serviceSubtotal = additional_services.reduce((sum, service) =>
      sum + (service.unit_price * service.quantity), 0);

    const subtotal = procedureSubtotal + serviceSubtotal;
    const tax = procedures.reduce((sum, proc) => sum + (proc.tax_amount || 0), 0) +
      additional_services.reduce((sum, service) => sum + (service.tax_amount || 0), 0);

    const total = subtotal + tax - discount;

    // Create procedure items
    const procedureItems = procedures.map(proc => ({
      procedure_code: proc.procedure_code,
      procedure_name: proc.procedure_name,
      quantity: proc.quantity,
      unit_price: proc.unit_price,
      total_price: proc.unit_price * proc.quantity,
      tax_rate: proc.tax_rate || 0,
      tax_amount: proc.tax_amount || 0,
      prescription_id: prescription_id,
      status: proc.status || 'Pending',
      scheduled_date: proc.scheduled_date,
      performed_by: proc.performed_by
    }));

    // Create service items
    const serviceItems = additional_services.map(service => ({
      description: service.description,
      quantity: service.quantity,
      unit_price: service.unit_price,
      total_price: service.unit_price * service.quantity,
      tax_rate: service.tax_rate || 0,
      tax_amount: service.tax_amount || 0,
      service_type: service.service_type || 'Other',
      prescription_id: prescription_id
    }));

    // Create invoice
    const invoice = new Invoice({
      invoice_type: 'Procedure',
      patient_id: patient_id,
      customer_type: 'Patient',
      procedure_items: procedureItems,
      service_items: serviceItems,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      total: total,
      status: 'Issued',
      payment_method: payment_method,
      notes: notes,
      created_by: req.user?._id,
      prescription_id: prescription_id,
      appointment_id: appointment_id,
      has_procedures: true,
      procedures_status: 'Pending',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    await invoice.save();

    // Update prescription procedures billing status
    if (prescription_id) {
      const prescription = await Prescription.findById(prescription_id);
      if (prescription) {
        procedures.forEach(proc => {
          const procIndex = prescription.recommendedProcedures.findIndex(
            p => p.procedure_code === proc.procedure_code
          );
          if (procIndex !== -1) {
            prescription.recommendedProcedures[procIndex].is_billed = true;
            prescription.recommendedProcedures[procIndex].invoice_id = invoice._id;
            prescription.recommendedProcedures[procIndex].cost = proc.unit_price * proc.quantity;
          }
        });
        await prescription.save();
      }
    }

    // Populate response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id', 'first_name last_name phone')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('appointment_id', 'appointment_date type')
      .populate('procedure_items.performed_by', 'firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Procedure invoice created successfully',
      invoice: populatedInvoice
    });

  } catch (err) {
    console.error('Error generating procedure invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get procedure invoices
exports.getProcedureInvoices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      patient_id,
      prescription_id,
      start_date,
      end_date
    } = req.query;

    const filter = { invoice_type: 'Procedure' };

    if (status) filter.status = status;
    if (patient_id) filter.patient_id = patient_id;
    if (prescription_id) filter.prescription_id = prescription_id;

    if (start_date && end_date) {
      filter.issue_date = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('prescription_id', 'prescription_number')
      .populate('appointment_id', 'appointment_date')
      .populate('procedure_items.performed_by', 'firstName lastName')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    // Calculate procedure statistics
    const procedureStats = await Invoice.aggregate([
      { $match: filter },
      { $unwind: '$procedure_items' },
      {
        $group: {
          _id: '$procedure_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$procedure_items.total_price' }
        }
      }
    ]);

    res.json({
      success: true,
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      procedureStats
    });
  } catch (err) {
    console.error('Error fetching procedure invoices:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update procedure status in invoice
exports.updateInvoiceProcedureStatus = async (req, res) => {
  try {
    const { invoiceId, procedureIndex } = req.params;
    const { status, performed_by, completed_date, notes } = req.body;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (procedureIndex >= invoice.procedure_items.length) {
      return res.status(404).json({ error: 'Procedure not found in invoice' });
    }

    // Update procedure
    if (status) {
      invoice.procedure_items[procedureIndex].status = status;

      if (status === 'Completed') {
        invoice.procedure_items[procedureIndex].completed_date = completed_date || new Date();
      }
    }

    if (performed_by) {
      invoice.procedure_items[procedureIndex].performed_by = performed_by;
    }

    if (notes) {
      // Add notes to procedure
      const currentNotes = invoice.procedure_items[procedureIndex].notes || '';
      invoice.procedure_items[procedureIndex].notes =
        currentNotes ? `${currentNotes}\n${notes}` : notes;
    }

    // Update invoice procedures status
    const totalProcedures = invoice.procedure_items.length;
    const completedProcedures = invoice.procedure_items.filter(p => p.status === 'Completed').length;

    if (completedProcedures === 0) {
      invoice.procedures_status = 'Pending';
    } else if (completedProcedures === totalProcedures) {
      invoice.procedures_status = 'Completed';
    } else {
      invoice.procedures_status = 'Partial';
    }

    await invoice.save();

    // Update prescription procedure status if prescription_id exists
    if (invoice.prescription_id) {
      const prescription = await Prescription.findById(invoice.prescription_id);
      if (prescription) {
        const procCode = invoice.procedure_items[procedureIndex].procedure_code;
        const procIndex = prescription.recommendedProcedures.findIndex(
          p => p.procedure_code === procCode
        );

        if (procIndex !== -1) {
          prescription.recommendedProcedures[procIndex].status = status;

          if (status === 'Completed') {
            prescription.recommendedProcedures[procIndex].completed_date = completed_date || new Date();
          }

          if (performed_by) {
            prescription.recommendedProcedures[procIndex].performed_by = performed_by;
          }

          await prescription.save();
        }
      }
    }

    res.json({
      success: true,
      message: 'Procedure status updated successfully',
      invoice: await Invoice.findById(invoiceId)
        .populate('procedure_items.performed_by', 'firstName lastName')
    });
  } catch (err) {
    console.error('Error updating procedure status:', err);
    res.status(500).json({ error: err.message });
  }
};


/* =====================================================================================
   ✅ NEW: LAB TEST INVOICE FUNCTIONS (ADDED, DOES NOT REMOVE ANY EXISTING FUNCTION)
   NOTE: Requires Invoice schema to have lab_test_items + has_lab_tests + lab_tests_status
         and Prescription schema to have recommendedLabTests (like recommendedProcedures).
===================================================================================== */

// Generate invoice for lab tests
exports.generateLabTestInvoice = async (req, res) => {
  try {
    const {
      prescription_id,
      patient_id,
      appointment_id,
      lab_tests,
      additional_services = [],
      discount = 0,
      notes,
      payment_method
    } = req.body;

    if (!lab_tests || lab_tests.length === 0) {
      return res.status(400).json({
        message: 'Invoice must contain at least one lab test.'
      });
    }

    // Calculate totals
    const labSubtotal = lab_tests.reduce((sum, t) => sum + (t.unit_price * t.quantity), 0);
    const serviceSubtotal = additional_services.reduce((sum, s) => sum + (s.unit_price * s.quantity), 0);

    const subtotal = labSubtotal + serviceSubtotal;
    const tax =
      lab_tests.reduce((sum, t) => sum + (t.tax_amount || 0), 0) +
      additional_services.reduce((sum, s) => sum + (s.tax_amount || 0), 0);

    const total = subtotal + tax - discount;

    const labTestItems = lab_tests.map(t => ({
      lab_test_code: t.lab_test_code,
      lab_test_name: t.lab_test_name,
      quantity: t.quantity,
      unit_price: t.unit_price,
      total_price: t.unit_price * t.quantity,
      tax_rate: t.tax_rate || 0,
      tax_amount: t.tax_amount || 0,
      prescription_id: prescription_id,
      status: t.status || 'Pending',
      scheduled_date: t.scheduled_date,
      sample_collected_at: t.sample_collected_at,
      completed_date: t.completed_date,
      performed_by: t.performed_by,
      notes: t.notes,
      report_url: t.report_url
    }));

    const serviceItems = additional_services.map(service => ({
      description: service.description,
      quantity: service.quantity,
      unit_price: service.unit_price,
      total_price: service.unit_price * service.quantity,
      tax_rate: service.tax_rate || 0,
      tax_amount: service.tax_amount || 0,
      service_type: service.service_type || 'Other',
      prescription_id: prescription_id
    }));

    const invoice = new Invoice({
      invoice_type: 'Lab Test',
      patient_id: patient_id,
      customer_type: 'Patient',
      lab_test_items: labTestItems,
      service_items: serviceItems,
      subtotal,
      discount,
      tax,
      total,
      status: 'Issued',
      payment_method,
      notes,
      created_by: req.user?._id,
      prescription_id,
      appointment_id,
      has_lab_tests: true,
      lab_tests_status: 'Pending',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await invoice.save();

    // Update prescription lab tests billing status (if your Prescription has recommendedLabTests)
    if (prescription_id) {
      const prescription = await Prescription.findById(prescription_id);
      if (prescription && Array.isArray(prescription.recommendedLabTests)) {
        lab_tests.forEach(t => {
          const idx = prescription.recommendedLabTests.findIndex(x => x.lab_test_code === t.lab_test_code);
          if (idx !== -1) {
            prescription.recommendedLabTests[idx].is_billed = true;
            prescription.recommendedLabTests[idx].invoice_id = invoice._id;
            prescription.recommendedLabTests[idx].cost = t.unit_price * t.quantity;
          }
        });
        await prescription.save();
      }
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id', 'first_name last_name phone')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('appointment_id', 'appointment_date type')
      .populate('lab_test_items.performed_by', 'firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Lab test invoice created successfully',
      invoice: populatedInvoice
    });
  } catch (err) {
    console.error('Error generating lab test invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get lab test invoices
exports.getLabTestInvoices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      patient_id,
      prescription_id,
      start_date,
      end_date
    } = req.query;

    const filter = { invoice_type: 'Lab Test' };

    if (status) filter.status = status;
    if (patient_id) filter.patient_id = patient_id;
    if (prescription_id) filter.prescription_id = prescription_id;

    if (start_date && end_date) {
      filter.issue_date = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('prescription_id', 'prescription_number')
      .populate('appointment_id', 'appointment_date')
      .populate('lab_test_items.performed_by', 'firstName lastName')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    const labTestStats = await Invoice.aggregate([
      { $match: filter },
      { $unwind: '$lab_test_items' },
      {
        $group: {
          _id: '$lab_test_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$lab_test_items.total_price' }
        }
      }
    ]);

    res.json({
      success: true,
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      labTestStats
    });
  } catch (err) {
    console.error('Error fetching lab test invoices:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get invoices with lab tests (similar to getInvoicesWithProcedures)
exports.getInvoicesWithLabTests = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      lab_tests_status,
      status,
      start_date,
      end_date
    } = req.query;

    const filter = { has_lab_tests: true };

    if (lab_tests_status) filter.lab_tests_status = lab_tests_status;
    if (status) filter.status = status;

    if (start_date && end_date) {
      filter.issue_date = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('prescription_id', 'prescription_number')
      .populate('appointment_id', 'appointment_date')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    const stats = await Invoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$lab_tests_status',
          count: { $sum: 1 },
          totalRevenue: { $sum: '$total' }
        }
      }
    ]);

    res.json({
      success: true,
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      statistics: stats
    });
  } catch (err) {
    console.error('Error fetching invoices with lab tests:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update lab test status in invoice
exports.updateInvoiceLabTestStatus = async (req, res) => {
  try {
    const { invoiceId, labTestIndex } = req.params;
    const { status, performed_by, completed_date, sample_collected_at, notes, report_url } = req.body;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!invoice.lab_test_items || labTestIndex >= invoice.lab_test_items.length) {
      return res.status(404).json({ error: 'Lab test not found in invoice' });
    }

    // Update lab test
    if (status) {
      invoice.lab_test_items[labTestIndex].status = status;

      if (status === 'Completed') {
        invoice.lab_test_items[labTestIndex].completed_date = completed_date || new Date();
      }
      if (status === 'Sample Collected') {
        invoice.lab_test_items[labTestIndex].sample_collected_at = sample_collected_at || new Date();
      }
    }

    if (performed_by) {
      invoice.lab_test_items[labTestIndex].performed_by = performed_by;
    }

    if (report_url) {
      invoice.lab_test_items[labTestIndex].report_url = report_url;
    }

    if (notes) {
      const currentNotes = invoice.lab_test_items[labTestIndex].notes || '';
      invoice.lab_test_items[labTestIndex].notes =
        currentNotes ? `${currentNotes}\n${notes}` : notes;
    }

    // Update invoice lab tests status
    const totalTests = invoice.lab_test_items.length;
    const completedTests = invoice.lab_test_items.filter(t => t.status === 'Completed').length;

    if (completedTests === 0) {
      invoice.lab_tests_status = 'Pending';
    } else if (completedTests === totalTests) {
      invoice.lab_tests_status = 'Completed';
    } else {
      invoice.lab_tests_status = 'Partial';
    }

    await invoice.save();

    // Sync into prescription if exists
    if (invoice.prescription_id) {
      const prescription = await Prescription.findById(invoice.prescription_id);
      if (prescription && Array.isArray(prescription.recommendedLabTests)) {
        const code = invoice.lab_test_items[labTestIndex].lab_test_code;
        const idx = prescription.recommendedLabTests.findIndex(t => t.lab_test_code === code);

        if (idx !== -1) {
          prescription.recommendedLabTests[idx].status = status;

          if (status === 'Completed') {
            prescription.recommendedLabTests[idx].completed_date = completed_date || new Date();
          }
          if (status === 'Sample Collected') {
            prescription.recommendedLabTests[idx].sample_collected_at = sample_collected_at || new Date();
          }
          if (performed_by) {
            prescription.recommendedLabTests[idx].performed_by = performed_by;
          }
          if (report_url) {
            prescription.recommendedLabTests[idx].report_url = report_url;
          }

          await prescription.save();
        }
      }
    }

    res.json({
      success: true,
      message: 'Lab test status updated successfully',
      invoice: await Invoice.findById(invoiceId)
        .populate('lab_test_items.performed_by', 'firstName lastName')
    });
  } catch (err) {
    console.error('Error updating lab test status:', err);
    res.status(500).json({ error: err.message });
  }
};


/* =====================================================================================
   EXISTING: Generate pharmacy invoice with stock management
   NOTE: You already have ANOTHER generatePharmacyInvoice later in this file.
         I am NOT removing it (as per your request).
===================================================================================== */

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

// Generate invoice PDF with procedures
exports.downloadInvoicePDF = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch invoice with populated data
    const invoice = await Invoice.findById(id)
      .populate('patient_id', 'first_name last_name phone address')
      .populate('appointment_id', 'appointment_date type')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('procedure_items.performed_by', 'firstName lastName')
      // ✅ NEW: populate lab test performer too
      .populate('lab_test_items.performed_by', 'firstName lastName')
      .populate('medicine_items.medicine_id', 'name generic_name')
      .populate('medicine_items.batch_id', 'batch_number expiry_date');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Create PDF document
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);

    // Pipe PDF to response
    doc.pipe(res);

    // Add header
    addHeader(doc);

    // Add invoice details
    addInvoiceDetails(doc, invoice);

    // Add customer/patient details
    addCustomerDetails(doc, invoice);

    // Add items table based on invoice type
    if (invoice.invoice_type === 'Procedure' || invoice.procedure_items.length > 0) {
      addProcedureItemsTable(doc, invoice);
    } else if (invoice.invoice_type === 'Lab Test' || (invoice.lab_test_items && invoice.lab_test_items.length > 0)) {
      // ✅ NEW: Lab test table
      addLabTestItemsTable(doc, invoice);
    } else if (invoice.invoice_type === 'Pharmacy') {
      addMedicineItemsTable(doc, invoice);
    } else {
      addServiceItemsTable(doc, invoice);
    }

    // Add totals and footer
    addFooter(doc, invoice);

    // Finalize PDF
    doc.end();

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
};

// Helper functions for PDF generation
function addHeader(doc) {
  // Hospital/Clinic header
  doc.fontSize(20).font('Helvetica-Bold').text('MEDICAL CENTER', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text('Tax Invoice/Bill of Supply', { align: 'center' });

  doc.moveDown(0.5);
  doc.fontSize(10).text('123 Medical Street, Healthcare City', { align: 'center' });
  doc.text('Phone: +91-9876543210 | Email: info@medicalcenter.com', { align: 'center' });
  doc.text('GSTIN: 27AAAAA0000A1Z5 | License No: MH/2023/12345', { align: 'center' });

  doc.moveTo(50, 130).lineTo(550, 130).stroke();
  doc.moveDown(1);
}

function addInvoiceDetails(doc, invoice) {
  const leftCol = 50;
  const rightCol = 350;
  let y = 150;

  doc.fontSize(12).font('Helvetica-Bold').text('INVOICE', leftCol, y);

  y += 30;
  doc.fontSize(10).font('Helvetica');

  // Left column - Invoice details
  doc.text('Invoice Number:', leftCol, y);
  doc.text(invoice.invoice_number, leftCol + 100, y);

  doc.text('Invoice Date:', leftCol, y + 15);
  doc.text(new Date(invoice.issue_date).toLocaleDateString(), leftCol + 100, y + 15);

  doc.text('Due Date:', leftCol, y + 30);
  doc.text(new Date(invoice.due_date).toLocaleDateString(), leftCol + 100, y + 30);

  // Right column - Prescription details
  if (invoice.prescription_id) {
    doc.text('Prescription No:', rightCol, y);
    doc.text(invoice.prescription_id.prescription_number, rightCol + 100, y);

    if (invoice.appointment_id) {
      doc.text('Appointment Date:', rightCol, y + 15);
      doc.text(new Date(invoice.appointment_id.appointment_date).toLocaleDateString(), rightCol + 100, y + 15);
    }
  }

  doc.moveDown(2);
}

function addCustomerDetails(doc, invoice) {
  doc.fontSize(11).font('Helvetica-Bold').text('Bill To:', 50, 240);

  doc.fontSize(10).font('Helvetica');

  if (invoice.patient_id) {
    doc.text(`Name: ${invoice.patient_id.first_name} ${invoice.patient_id.last_name}`, 50, 260);
    doc.text(`Phone: ${invoice.patient_id.phone || 'N/A'}`, 50, 275);
    doc.text(`Address: ${invoice.patient_id.address || 'N/A'}`, 50, 290, { width: 300 });
  } else {
    doc.text(`Name: ${invoice.customer_name || 'N/A'}`, 50, 260);
    doc.text(`Phone: ${invoice.customer_phone || 'N/A'}`, 50, 275);
  }

  doc.moveDown(3);
}

function addProcedureItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Description', 'Qty', 'Unit Price', 'Amount', 'Status'];
  const colWidths = [60, 200, 50, 80, 80, 70];
  let x = 50;

  // Table headers
  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  // Draw header line
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  // Procedure items
  invoice.procedure_items.forEach((item, index) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
      // Redraw headers on new page
      x = 50;
      headers.forEach((header, i) => {
        doc.fontSize(10).font('Helvetica-Bold').text(header, x, y);
        x += colWidths[i];
      });
      y += 30;
      doc.moveTo(50, y - 15).lineTo(550, y - 15).stroke();
    }

    x = 50;
    doc.text(item.procedure_code, x, y);
    x += colWidths[0];

    doc.text(item.procedure_name, x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text(item.quantity.toString(), x, y);
    x += colWidths[2];

    doc.text(`₹${item.unit_price.toFixed(2)}`, x, y);
    x += colWidths[3];

    doc.text(`₹${item.total_price.toFixed(2)}`, x, y);
    x += colWidths[4];

    // Status with color coding
    const status = item.status || 'Pending';
    const statusColors = {
      'Completed': '#10B981',
      'In Progress': '#3B82F6',
      'Scheduled': '#8B5CF6',
      'Pending': '#EF4444'
    };

    doc.fillColor(statusColors[status] || '#6B7280');
    doc.text(status, x, y);
    doc.fillColor('#000000'); // Reset to black

    y += 20;
  });

  // Service items if any
  invoice.service_items.forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    x = 50;
    doc.text('SVC', x, y);
    x += colWidths[0];

    doc.text(item.description, x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text(item.quantity.toString(), x, y);
    x += colWidths[2];

    doc.text(`₹${item.unit_price.toFixed(2)}`, x, y);
    x += colWidths[3];

    doc.text(`₹${item.total_price.toFixed(2)}`, x, y);
    x += colWidths[4];

    doc.text('N/A', x, y);

    y += 20;
  });

  return y;
}

/* =========================
   ✅ NEW: Lab Test Items Table
========================= */
function addLabTestItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Test Name', 'Qty', 'Unit Price', 'Amount', 'Status'];
  const colWidths = [60, 200, 50, 80, 80, 70];
  let x = 50;

  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  (invoice.lab_test_items || []).forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    x = 50;
    doc.text(item.lab_test_code || 'LT', x, y);
    x += colWidths[0];

    doc.text(item.lab_test_name || 'Lab Test', x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text((item.quantity || 1).toString(), x, y);
    x += colWidths[2];

    doc.text(`₹${Number(item.unit_price || 0).toFixed(2)}`, x, y);
    x += colWidths[3];

    doc.text(`₹${Number(item.total_price || 0).toFixed(2)}`, x, y);
    x += colWidths[4];

    const status = item.status || 'Pending';
    const statusColors = {
      'Completed': '#10B981',
      'In Progress': '#3B82F6',
      'Scheduled': '#8B5CF6',
      'Sample Collected': '#F59E0B',
      'Pending': '#EF4444'
    };

    doc.fillColor(statusColors[status] || '#6B7280');
    doc.text(status, x, y);
    doc.fillColor('#000000');

    y += 20;
  });

  // service items if any
  (invoice.service_items || []).forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    x = 50;
    doc.text('SVC', x, y);
    x += colWidths[0];

    doc.text(item.description, x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text((item.quantity || 1).toString(), x, y);
    x += colWidths[2];

    doc.text(`₹${Number(item.unit_price || 0).toFixed(2)}`, x, y);
    x += colWidths[3];

    doc.text(`₹${Number(item.total_price || 0).toFixed(2)}`, x, y);
    x += colWidths[4];

    doc.text('N/A', x, y);

    y += 20;
  });

  return y;
}

function addMedicineItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Description', 'Batch', 'Qty', 'Unit Price', 'Amount'];
  const colWidths = [60, 180, 70, 50, 80, 80];
  let x = 50;

  // Table headers
  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  // Draw header line
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  // Medicine items
  invoice.medicine_items.forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    x = 50;
    doc.text(item.batch_id?.batch_number?.slice(-4) || 'N/A', x, y);
    x += colWidths[0];

    const medName = item.medicine_name || (item.medicine_id?.name || 'Medicine');
    const batchInfo = item.batch_number ? ` (Batch: ${item.batch_number})` : '';
    doc.text(`${medName}${batchInfo}`, x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text(item.batch_number || 'N/A', x, y);
    x += colWidths[2];

    doc.text(item.quantity.toString(), x, y);
    x += colWidths[3];

    doc.text(`₹${item.unit_price.toFixed(2)}`, x, y);
    x += colWidths[4];

    doc.text(`₹${item.total_price.toFixed(2)}`, x, y);

    y += 20;
  });

  return y;
}

function addServiceItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Description', 'Qty', 'Unit Price', 'Amount'];
  const colWidths = [60, 250, 50, 90, 90];
  let x = 50;

  // Table headers
  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  // Draw header line
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  // Service items
  invoice.service_items.forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    x = 50;
    doc.text('SVC', x, y);
    x += colWidths[0];

    doc.text(item.description, x, y, { width: colWidths[1] - 10 });
    x += colWidths[1];

    doc.text(item.quantity.toString(), x, y);
    x += colWidths[2];

    doc.text(`₹${item.unit_price.toFixed(2)}`, x, y);
    x += colWidths[3];

    doc.text(`₹${item.total_price.toFixed(2)}`, x, y);

    y += 20;
  });

  return y;
}

/* =========================================================
   IMPORTANT FIX:
   You had TWO functions named addFooter.
   The second one overwrote the first.
   ✅ Keep the first rich footer as addFooter()
   ✅ Rename the second to addFooterSimple()
========================================================= */

function addFooter(doc, invoice) {
  const footerY = 650;

  // Summary section
  const summaryX = 400;
  doc.fontSize(10).font('Helvetica');

  doc.text('Subtotal:', summaryX, footerY, { align: 'right' });
  doc.text(`₹${invoice.subtotal.toFixed(2)}`, 550, footerY, { align: 'right' });

  if (invoice.tax > 0) {
    doc.text('Tax:', summaryX, footerY + 15, { align: 'right' });
    doc.text(`₹${invoice.tax.toFixed(2)}`, 550, footerY + 15, { align: 'right' });
  }

  if (invoice.discount > 0) {
    doc.text('Discount:', summaryX, footerY + 30, { align: 'right' });
    doc.text(`-₹${invoice.discount.toFixed(2)}`, 550, footerY + 30, { align: 'right' });
  }

  doc.fontSize(11).font('Helvetica-Bold');
  doc.text('Total:', summaryX, footerY + 45, { align: 'right' });
  doc.text(`₹${invoice.total.toFixed(2)}`, 550, footerY + 45, { align: 'right' });

  doc.fontSize(10).font('Helvetica');
  doc.text(`Amount Paid: ₹${invoice.amount_paid.toFixed(2)}`, summaryX, footerY + 65, { align: 'right' });
  doc.text(`Balance Due: ₹${invoice.balance_due.toFixed(2)}`, summaryX, footerY + 80, { align: 'right' });

  // Payment status
  const statusColors = {
    'Paid': '#10B981',
    'Partial': '#3B82F6',
    'Pending': '#EF4444',
    'Overdue': '#DC2626'
  };

  doc.fillColor(statusColors[invoice.status] || '#6B7280');
  doc.text(`Status: ${invoice.status}`, 50, footerY + 80);
  doc.fillColor('#000000');

  // Footer notes
  doc.fontSize(8).text('Thank you for choosing our services!', 50, 750, { align: 'center' });
  doc.text('This is a computer generated invoice and does not require a physical signature.', 50, 765, { align: 'center' });
  doc.text('For any queries, please contact our billing department.', 50, 780, { align: 'center' });

  // Procedures status if applicable
  if (invoice.has_procedures) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Procedures Status: ${invoice.procedures_status}`, 50, 800);

    if (invoice.procedure_items && invoice.procedure_items.length > 0) {
      const pendingCount = invoice.procedure_items.filter(p => p.status === 'Pending').length;
      const completedCount = invoice.procedure_items.filter(p => p.status === 'Completed').length;
      doc.text(`Pending: ${pendingCount} | Completed: ${completedCount} | Total: ${invoice.procedure_items.length}`,
        50, 815);
    }
  }

  // ✅ NEW: Lab tests status if applicable
  if (invoice.has_lab_tests) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Lab Tests Status: ${invoice.lab_tests_status}`, 50, 835);

    if (invoice.lab_test_items && invoice.lab_test_items.length > 0) {
      const pendingCount = invoice.lab_test_items.filter(t => t.status === 'Pending').length;
      const completedCount = invoice.lab_test_items.filter(t => t.status === 'Completed').length;
      doc.text(`Pending: ${pendingCount} | Completed: ${completedCount} | Total: ${invoice.lab_test_items.length}`,
        50, 850);
    }
  }
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

/* ✅ This is your SECOND footer, renamed so it no longer overwrites addFooter() */
function addFooterSimple(doc, invoice) {
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
}

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

// Get daily revenue for pharmacy
exports.getPharmacyDailyRevenue = async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const result = await Invoice.aggregate([
      {
        $match: {
          invoice_type: 'Pharmacy',
          status: 'Paid',
          issue_date: { $gte: startOfDay, $lte: endOfDay }
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

    if (!appointment.patient_id) {
      return res.status(400).json({ error: 'Appointment has no associated patient. Please check the appointment record.' });
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
      created_by: req.user ? req.user._id : null
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

// Get invoices with procedures
exports.getInvoicesWithProcedures = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      procedures_status,
      status,
      start_date,
      end_date
    } = req.query;

    const filter = { has_procedures: true };

    if (procedures_status) filter.procedures_status = procedures_status;
    if (status) filter.status = status;

    if (start_date && end_date) {
      filter.issue_date = {
        $gte: new Date(start_date),
        $lte: new Date(end_date)
      };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('prescription_id', 'prescription_number')
      .populate('appointment_id', 'appointment_date')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    // Calculate procedure statistics
    const stats = await Invoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$procedures_status',
          count: { $sum: 1 },
          totalRevenue: { $sum: '$total' }
        }
      }
    ]);

    res.json({
      success: true,
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      statistics: stats
    });
  } catch (err) {
    console.error('Error fetching invoices with procedures:', err);
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
      date: new Date(),
      status: 'Completed'
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

      // Update bill status if exists
      if (invoice.bill_id) {
        await Bill.findByIdAndUpdate(invoice.bill_id, {
          status: 'Paid',
          paid_amount: invoice.total,
          paid_at: new Date()
        });
      }

    } else if (invoice.amount_paid > 0) {
      invoice.status = 'Partial';

      // Update bill status if exists
      if (invoice.bill_id) {
        await Bill.findByIdAndUpdate(invoice.bill_id, {
          status: 'Partially Paid',
          paid_amount: invoice.amount_paid
        });
      }
    }

    await invoice.save();

    res.json({
      success: true,
      message: 'Payment updated successfully',
      invoice: await Invoice.findById(invoice._id)
        .populate('patient_id')
        .populate('prescription_id')
        .populate('bill_id')
    });
  } catch (err) {
    console.error('Error updating invoice payment:', err);
    res.status(400).json({ error: err.message });
  }
};

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

// Get invoice statistics including procedures
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
      {
        $group: {
          _id: '$invoice_type',
          total: { $sum: '$total' },
          count: { $sum: 1 },
          avg: { $avg: '$total' }
        }
      }
    ]);

    const statusCounts = await Invoice.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    // Procedure specific statistics
    const procedureStats = await Invoice.aggregate([
      { $match: { ...filter, has_procedures: true } },
      { $unwind: '$procedure_items' },
      {
        $group: {
          _id: '$procedure_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$procedure_items.total_price' }
        }
      }
    ]);

    const procedureRevenue = await Invoice.aggregate([
      { $match: { ...filter, invoice_type: 'Procedure' } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
    ]);

    // ✅ NEW: Lab test statistics
    const labTestStats = await Invoice.aggregate([
      { $match: { ...filter, has_lab_tests: true } },
      { $unwind: '$lab_test_items' },
      {
        $group: {
          _id: '$lab_test_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$lab_test_items.total_price' }
        }
      }
    ]);

    const labTestRevenue = await Invoice.aggregate([
      { $match: { ...filter, invoice_type: 'Lab Test' } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
    ]);

    res.json({
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      paidRevenue: paidRevenue[0]?.total || 0,
      pendingRevenue: (totalRevenue[0]?.total || 0) - (paidRevenue[0]?.total || 0),
      revenueByType,
      statusCounts,
      procedureStats,
      procedureRevenue: procedureRevenue[0]?.total || 0,
      procedureCount: procedureRevenue[0]?.count || 0,

      // ✅ NEW
      labTestStats,
      labTestRevenue: labTestRevenue[0]?.total || 0,
      labTestCount: labTestRevenue[0]?.count || 0
    });
  } catch (err) {
    console.error('Error fetching invoice statistics:', err);
    res.status(500).json({ error: err.message });
  }
};

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
