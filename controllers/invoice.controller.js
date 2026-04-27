const Invoice = require('../models/Invoice');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const Hospital = require('../models/Hospital');
const Pharmacy = require('../models/Pharmacy');
const Bill = require('../models/Bill');
const ProcedureRequest = require('../models/ProcedureRequest');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const PDFDocument = require('pdfkit');
const { default: mongoose } = require('mongoose');

// ============== PROCEDURE INVOICE FUNCTIONS ==============

// Generate invoice for procedures (using procedure_requests from prescription)
exports.generateProcedureInvoice = async (req, res) => {
  try {
    const {
      prescription_id,
      patient_id,
      appointment_id,
      procedure_request_ids,  // Array of _id from prescription.procedure_requests
      additional_services = [],
      discount = 0,
      notes,
      payment_method
    } = req.body;

    if (!procedure_request_ids || procedure_request_ids.length === 0) {
      return res.status(400).json({
        message: 'Invoice must contain at least one procedure.'
      });
    }

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const selectedProcedures = (prescription.procedure_requests || []).filter(proc =>
      procedure_request_ids.includes(proc._id.toString())
    );

    if (selectedProcedures.length === 0) {
      return res.status(400).json({ error: 'No procedures found in prescription' });
    }

    let procedureSubtotal = 0;
    const procedureItems = [];

    for (const proc of selectedProcedures) {
      let unitPrice = proc.cost || 0;
      if (unitPrice === 0 && proc.procedure_code) {
        const procedureMaster = await Procedure.findOne({ code: proc.procedure_code });
        unitPrice = procedureMaster?.base_price || 0;
      }

      const totalPrice = unitPrice;
      procedureSubtotal += totalPrice;

      procedureItems.push({
        procedure_code: proc.procedure_code,
        procedure_name: proc.procedure_name,
        quantity: 1,
        unit_price: unitPrice,
        total_price: totalPrice,
        tax_rate: 0,
        tax_amount: 0,
        prescription_id: prescription_id,
        procedure_request_id: proc._id,
        status: proc.status || 'Pending',
        scheduled_date: proc.scheduled_date
      });
    }

    const serviceSubtotal = additional_services.reduce((sum, service) =>
      sum + (service.unit_price * service.quantity), 0);

    const subtotal = procedureSubtotal + serviceSubtotal;
    const total = subtotal - discount;

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
      invoice_type: 'Procedure',
      patient_id: patient_id || prescription.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${prescription.patient_id.first_name} ${prescription.patient_id.last_name}`,
      customer_phone: prescription.patient_id.phone,
      procedure_items: procedureItems,
      service_items: serviceItems,
      subtotal: subtotal,
      discount: discount,
      tax: 0,
      total: total,
      status: 'Issued',
      payment_method: payment_method || 'Pending',
      notes: notes,
      created_by: req.user?._id,
      prescription_id: prescription_id,
      appointment_id: appointment_id,
      has_procedures: true,
      procedures_status: 'Pending',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await invoice.save();

    // Update prescription procedure_requests billing status
    for (const proc of selectedProcedures) {
      const procIndex = prescription.procedure_requests.findIndex(
        p => p._id.toString() === proc._id.toString()
      );
      if (procIndex !== -1) {
        prescription.procedure_requests[procIndex].is_billed = true;
        prescription.procedure_requests[procIndex].invoice_id = invoice._id;
      }
    }
    await prescription.save();

    const requestIds = selectedProcedures.map(p => p.request_id).filter(id => id);
    if (requestIds.length > 0) {
      await ProcedureRequest.updateMany(
        { _id: { $in: requestIds } },
        { is_billed: true, invoiceId: invoice._id }
      );
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id', 'first_name last_name phone')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('appointment_id', 'appointment_date type')
      .populate('procedure_items.performed_by', 'firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Procedure invoice created successfully',
      invoice: populatedInvoice,
      procedures_billed: selectedProcedures.length
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
      const currentNotes = invoice.procedure_items[procedureIndex].notes || '';
      invoice.procedure_items[procedureIndex].notes = currentNotes ? `${currentNotes}\n${notes}` : notes;
    }

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

    if (invoice.prescription_id) {
      const prescription = await Prescription.findById(invoice.prescription_id);
      if (prescription && prescription.procedure_requests) {
        const procId = invoice.procedure_items[procedureIndex].procedure_request_id;
        if (procId) {
          const procIndex = prescription.procedure_requests.findIndex(p => p._id.toString() === procId.toString());
          if (procIndex !== -1) {
            prescription.procedure_requests[procIndex].status = status;
            if (status === 'Completed') {
              prescription.procedure_requests[procIndex].completed_date = completed_date || new Date();
            }
            await prescription.save();
          }
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

// ============== LAB TEST INVOICE FUNCTIONS ==============

// Generate invoice for lab tests
exports.generateLabTestInvoice = async (req, res) => {
  try {
    const {
      prescription_id,
      patient_id,
      appointment_id,
      lab_test_request_ids,
      additional_services = [],
      discount = 0,
      notes,
      payment_method
    } = req.body;

    if (!lab_test_request_ids || lab_test_request_ids.length === 0) {
      return res.status(400).json({
        message: 'Invoice must contain at least one lab test.'
      });
    }

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const selectedLabTests = (prescription.lab_test_requests || []).filter(test =>
      lab_test_request_ids.includes(test._id.toString())
    );

    if (selectedLabTests.length === 0) {
      return res.status(400).json({ error: 'No lab tests found in prescription' });
    }

    let labSubtotal = 0;
    const labTestItems = [];

    for (const test of selectedLabTests) {
      let unitPrice = test.cost || 0;
      if (unitPrice === 0 && test.lab_test_code) {
        const labTestMaster = await LabTest.findOne({ code: test.lab_test_code });
        unitPrice = labTestMaster?.base_price || 0;
      }

      const totalPrice = unitPrice;
      labSubtotal += totalPrice;

      labTestItems.push({
        lab_test_code: test.lab_test_code,
        lab_test_name: test.lab_test_name,
        quantity: 1,
        unit_price: unitPrice,
        total_price: totalPrice,
        tax_rate: 0,
        tax_amount: 0,
        prescription_id: prescription_id,
        lab_test_request_id: test._id,
        status: test.priority === 'Stat' ? 'Urgent' : 'Pending',
        scheduled_date: test.scheduled_date
      });
    }

    const serviceSubtotal = additional_services.reduce((sum, s) => sum + (s.unit_price * s.quantity), 0);
    const subtotal = labSubtotal + serviceSubtotal;
    const total = subtotal - discount;

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
      patient_id: patient_id || prescription.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${prescription.patient_id.first_name} ${prescription.patient_id.last_name}`,
      customer_phone: prescription.patient_id.phone,
      lab_test_items: labTestItems,
      service_items: serviceItems,
      subtotal: subtotal,
      discount: discount,
      tax: 0,
      total: total,
      status: 'Issued',
      payment_method: payment_method || 'Pending',
      notes: notes,
      created_by: req.user?._id,
      prescription_id: prescription_id,
      appointment_id: appointment_id,
      has_lab_tests: true,
      lab_tests_status: 'Pending',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await invoice.save();

    for (const test of selectedLabTests) {
      const testIndex = prescription.lab_test_requests.findIndex(t => t._id.toString() === test._id.toString());
      if (testIndex !== -1) {
        prescription.lab_test_requests[testIndex].is_billed = true;
        prescription.lab_test_requests[testIndex].invoice_id = invoice._id;
      }
    }
    await prescription.save();

    const requestIds = selectedLabTests.map(t => t.request_id).filter(id => id);
    if (requestIds.length > 0) {
      await LabRequest.updateMany(
        { _id: { $in: requestIds } },
        { is_billed: true, invoiceId: invoice._id }
      );
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id', 'first_name last_name phone')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('appointment_id', 'appointment_date type')
      .populate('lab_test_items.performed_by', 'firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Lab test invoice created successfully',
      invoice: populatedInvoice,
      lab_tests_billed: selectedLabTests.length
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
      invoice.lab_test_items[labTestIndex].notes = currentNotes ? `${currentNotes}\n${notes}` : notes;
    }

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

    if (invoice.prescription_id) {
      const prescription = await Prescription.findById(invoice.prescription_id);
      if (prescription && prescription.lab_test_requests) {
        const testRequestId = invoice.lab_test_items[labTestIndex].lab_test_request_id;
        if (testRequestId) {
          const testIndex = prescription.lab_test_requests.findIndex(t => t._id.toString() === testRequestId.toString());
          if (testIndex !== -1) {
            prescription.lab_test_requests[testIndex].status = status;
            if (status === 'Completed') {
              prescription.lab_test_requests[testIndex].completed_date = completed_date || new Date();
            }
            await prescription.save();
          }
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

// Get invoices with lab tests
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

// ============== RADIOLOGY INVOICE FUNCTIONS ==============

// Generate invoice for radiology tests
exports.generateRadiologyInvoice = async (req, res) => {
  try {
    const {
      prescription_id,
      patient_id,
      appointment_id,
      radiology_request_ids,
      additional_services = [],
      discount = 0,
      notes,
      payment_method
    } = req.body;

    if (!radiology_request_ids || radiology_request_ids.length === 0) {
      return res.status(400).json({
        message: 'Invoice must contain at least one radiology test.'
      });
    }

    const prescription = await Prescription.findById(prescription_id)
      .populate('patient_id')
      .populate('doctor_id');

    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const selectedRadiology = (prescription.radiology_test_requests || []).filter(rad =>
      radiology_request_ids.includes(rad._id.toString())
    );

    if (selectedRadiology.length === 0) {
      return res.status(400).json({ error: 'No radiology tests found in prescription' });
    }

    let radiologySubtotal = 0;
    const radiologyItems = [];

    for (const rad of selectedRadiology) {
      let unitPrice = rad.cost || 0;
      if (unitPrice === 0 && rad.imaging_test_code) {
        const imagingTest = await ImagingTest.findOne({ code: rad.imaging_test_code });
        unitPrice = imagingTest?.base_price || 0;
      }

      const totalPrice = unitPrice;
      radiologySubtotal += totalPrice;

      radiologyItems.push({
        imaging_test_code: rad.imaging_test_code,
        imaging_test_name: rad.imaging_test_name,
        category: rad.category,
        quantity: 1,
        unit_price: unitPrice,
        total_price: totalPrice,
        tax_rate: 0,
        tax_amount: 0,
        prescription_id: prescription_id,
        radiology_request_id: rad._id,
        status: rad.priority === 'Emergency' ? 'Urgent' : (rad.priority === 'Urgent' ? 'Urgent' : 'Pending'),
        scheduled_date: rad.scheduled_date
      });
    }

    const serviceSubtotal = additional_services.reduce((sum, s) => sum + (s.unit_price * s.quantity), 0);
    const subtotal = radiologySubtotal + serviceSubtotal;
    const total = subtotal - discount;

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
      invoice_type: 'Radiology',
      patient_id: patient_id || prescription.patient_id._id,
      customer_type: 'Patient',
      customer_name: `${prescription.patient_id.first_name} ${prescription.patient_id.last_name}`,
      customer_phone: prescription.patient_id.phone,
      radiology_items: radiologyItems,
      service_items: serviceItems,
      subtotal: subtotal,
      discount: discount,
      tax: 0,
      total: total,
      status: 'Issued',
      payment_method: payment_method || 'Pending',
      notes: notes,
      created_by: req.user?._id,
      prescription_id: prescription_id,
      appointment_id: appointment_id,
      has_radiology: true,
      radiology_status: 'Pending',
      issue_date: new Date(),
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });

    await invoice.save();

    for (const rad of selectedRadiology) {
      const radIndex = prescription.radiology_test_requests.findIndex(r => r._id.toString() === rad._id.toString());
      if (radIndex !== -1) {
        prescription.radiology_test_requests[radIndex].is_billed = true;
        prescription.radiology_test_requests[radIndex].invoice_id = invoice._id;
      }
    }
    await prescription.save();

    const requestIds = selectedRadiology.map(r => r.request_id).filter(id => id);
    if (requestIds.length > 0) {
      await RadiologyRequest.updateMany(
        { _id: { $in: requestIds } },
        { is_billed: true, invoiceId: invoice._id }
      );
    }

    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate('patient_id', 'first_name last_name phone')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('appointment_id', 'appointment_date type')
      .populate('radiology_items.performed_by', 'firstName lastName')
      .populate('radiology_items.reported_by', 'firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Radiology invoice created successfully',
      invoice: populatedInvoice,
      radiology_billed: selectedRadiology.length
    });
  } catch (err) {
    console.error('Error generating radiology invoice:', err);
    res.status(400).json({ error: err.message });
  }
};

// Get radiology invoices
exports.getRadiologyInvoices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      radiology_status,
      patient_id,
      prescription_id,
      start_date,
      end_date
    } = req.query;

    const filter = { invoice_type: 'Radiology' };

    if (status) filter.status = status;
    if (radiology_status) filter.radiology_status = radiology_status;
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
      .populate('radiology_items.performed_by', 'firstName lastName')
      .populate('radiology_items.reported_by', 'firstName lastName')
      .sort({ issue_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(filter);

    const radiologyStats = await Invoice.aggregate([
      { $match: filter },
      { $unwind: '$radiology_items' },
      {
        $group: {
          _id: '$radiology_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$radiology_items.total_price' }
        }
      }
    ]);

    res.json({
      success: true,
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
      radiologyStats
    });
  } catch (err) {
    console.error('Error fetching radiology invoices:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update radiology test status in invoice
exports.updateInvoiceRadiologyStatus = async (req, res) => {
  try {
    const { invoiceId, radiologyIndex } = req.params;
    const { status, performed_by, reported_by, performed_at, reported_at, notes, report_url } = req.body;

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!invoice.radiology_items || radiologyIndex >= invoice.radiology_items.length) {
      return res.status(404).json({ error: 'Radiology test not found in invoice' });
    }

    if (status) {
      invoice.radiology_items[radiologyIndex].status = status;
      if (status === 'Reported' || status === 'Completed') {
        invoice.radiology_items[radiologyIndex].reported_at = reported_at || new Date();
      }
      if (status === 'In Progress') {
        invoice.radiology_items[radiologyIndex].performed_at = performed_at || new Date();
      }
    }

    if (performed_by) {
      invoice.radiology_items[radiologyIndex].performed_by = performed_by;
    }

    if (reported_by) {
      invoice.radiology_items[radiologyIndex].reported_by = reported_by;
    }

    if (report_url) {
      invoice.radiology_items[radiologyIndex].report_url = report_url;
    }

    if (notes) {
      const currentNotes = invoice.radiology_items[radiologyIndex].notes || '';
      invoice.radiology_items[radiologyIndex].notes = currentNotes ? `${currentNotes}\n${notes}` : notes;
    }

    const totalTests = invoice.radiology_items.length;
    const reportedTests = invoice.radiology_items.filter(t => t.status === 'Reported' || t.status === 'Completed').length;

    if (reportedTests === 0) {
      invoice.radiology_status = 'Pending';
    } else if (reportedTests === totalTests) {
      invoice.radiology_status = 'Reported';
    } else {
      invoice.radiology_status = 'Partial';
    }

    await invoice.save();

    if (invoice.prescription_id) {
      const prescription = await Prescription.findById(invoice.prescription_id);
      if (prescription && prescription.radiology_test_requests) {
        const radRequestId = invoice.radiology_items[radiologyIndex].radiology_request_id;
        if (radRequestId) {
          const radIndex = prescription.radiology_test_requests.findIndex(r => r._id.toString() === radRequestId.toString());
          if (radIndex !== -1) {
            prescription.radiology_test_requests[radIndex].status = status;
            await prescription.save();
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'Radiology test status updated successfully',
      invoice: await Invoice.findById(invoiceId)
        .populate('radiology_items.performed_by', 'firstName lastName')
        .populate('radiology_items.reported_by', 'firstName lastName')
    });
  } catch (err) {
    console.error('Error updating radiology test status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get invoices with radiology
exports.getInvoicesWithRadiology = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      radiology_status,
      status,
      start_date,
      end_date
    } = req.query;

    const filter = { has_radiology: true };

    if (radiology_status) filter.radiology_status = radiology_status;
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
          _id: '$radiology_status',
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
    console.error('Error fetching invoices with radiology:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============== PHARMACY INVOICE FUNCTIONS (PRESERVING ORIGINAL) ==============

// Generate pharmacy invoice with stock management
exports.generatePharmacyInvoice = async (req, res) => {
  try {
    const { prescription_id, patient_id, items, discount = 0, notes, payment_method } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'Invoice must contain at least one item.' });
    }

    const subtotal = items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    const tax = items.reduce((sum, item) => sum + (item.tax_amount || 0), 0);
    const total = subtotal + tax - discount;

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

    for (const item of items) {
      await Medicine.findByIdAndUpdate(
        item.medicine_id,
        { $inc: { stock_quantity: -item.quantity } }
      );
    }

    if (prescription_id) {
      await Prescription.findByIdAndDelete(prescription_id);
    }

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

// Get pharmacy invoices
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

// ============== APPOINTMENT INVOICE FUNCTIONS ==============

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

// ============== PURCHASE INVOICE FUNCTIONS ==============

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
      total: total,
      status: 'Issued',
      notes: notes,
      created_by: req.user._id
    });

    await invoice.save();

    if (purchase_order_id) {
      await PurchaseOrder.findByIdAndUpdate(purchase_order_id, {
        invoice_id: invoice._id,
        status: 'Ordered'
      });
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

// ============== COMMON INVOICE FUNCTIONS (PRESERVING ALL ORIGINAL RETURN VALUES) ==============

// Get all invoices with filters
exports.getAllInvoices = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      invoice_type,
      payment_method,
      patient_id,
      customer_type,
      patient_type,
      doctor_id,
      department_id,
      has_procedures,
      has_lab_tests,
      has_radiology,
      is_pharmacy_sale,
      min_amount,
      max_amount,
      startDate,
      endDate
    } = req.query;

    const filter = {};

    if (status) filter.status = status;
    if (invoice_type) filter.invoice_type = invoice_type;
    if (payment_method) filter['payment_history.method'] = payment_method;
    if (patient_id) filter.patient_id = patient_id;
    if (customer_type) filter.customer_type = customer_type;
    if (has_procedures === 'true') filter.has_procedures = true;
    if (has_lab_tests === 'true') filter.has_lab_tests = true;
    if (has_radiology === 'true') filter.has_radiology = true;
    if (is_pharmacy_sale === 'true') filter.is_pharmacy_sale = true;

    if (min_amount || max_amount) {
      filter.total = {};
      if (min_amount) filter.total.$gte = parseFloat(min_amount);
      if (max_amount) filter.total.$lte = parseFloat(max_amount);
    }

    if (startDate && endDate) {
      filter.issue_date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const pipeline = [];
    pipeline.push({ $match: filter });

    if (doctor_id || department_id) {
      pipeline.push(
        {
          $lookup: {
            from: 'appointments',
            localField: 'appointment_id',
            foreignField: '_id',
            as: 'appointment_info'
          }
        },
        { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: true } }
      );

      if (doctor_id) {
        pipeline.push({
          $match: { 'appointment_info.doctor_id': new mongoose.Types.ObjectId(doctor_id) }
        });
      }

      if (department_id) {
        pipeline.push(
          {
            $lookup: {
              from: 'doctors',
              localField: 'appointment_info.doctor_id',
              foreignField: '_id',
              as: 'doctor_info'
            }
          },
          { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } },
          {
            $match: {
              'doctor_info.department': new mongoose.Types.ObjectId(department_id)
            }
          }
        );
      }
    }

    if (patient_type) {
      pipeline.push(
        {
          $lookup: {
            from: 'patients',
            localField: 'patient_id',
            foreignField: '_id',
            as: 'patient_info'
          }
        },
        { $unwind: { path: '$patient_info', preserveNullAndEmptyArrays: true } },
        { $match: { 'patient_info.patient_type': patient_type } }
      );
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Invoice.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    pipeline.push(
      { $sort: { issue_date: -1 } },
      { $skip: (parseInt(page) - 1) * parseInt(limit) },
      { $limit: parseInt(limit) },
      {
        $project: {
          invoice_number: 1,
          invoice_type: 1,
          issue_date: 1,
          due_date: 1,
          total: 1,
          amount_paid: 1,
          balance_due: 1,
          status: 1,
          payment_history: 1,
          has_procedures: 1,
          has_lab_tests: 1,
          has_radiology: 1,
          is_pharmacy_sale: 1,
          service_items: 1,
          procedure_items: { $size: { $ifNull: ['$procedure_items', []] } },
          lab_test_items: { $size: { $ifNull: ['$lab_test_items', []] } },
          radiology_items: { $size: { $ifNull: ['$radiology_items', []] } },
          patient_id: {
            _id: 1,
            first_name: 1,
            last_name: 1,
            patientId: 1,
            patient_type: 1
          },
          customer_name: 1,
          customer_phone: 1,
          appointment_id: 1
        }
      }
    );

    const invoices = await Invoice.aggregate(pipeline);

    res.json({
      invoices,
      totalPages: Math.ceil(total / parseInt(limit)),
      currentPage: parseInt(page),
      total
    });
  } catch (err) {
    console.error('Error in getAllInvoices:', err);
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
      .populate('prescription_id');

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

    invoice.payment_history.push({
      amount: amount,
      method: method,
      reference: reference,
      collected_by: collected_by,
      date: new Date(),
      status: 'Completed'
    });

    invoice.amount_paid += amount;
    invoice.balance_due = invoice.total - invoice.amount_paid;

    if (invoice.amount_paid >= invoice.total) {
      invoice.status = 'Paid';

      if (invoice.sale_id) {
        await Sale.findByIdAndUpdate(invoice.sale_id, {
          status: 'Completed',
          payment_method: method
        });
      }

      if (invoice.bill_id) {
        await Bill.findByIdAndUpdate(invoice.bill_id, {
          status: 'Paid',
          paid_amount: invoice.total,
          paid_at: new Date()
        });
      }

    } else if (invoice.amount_paid > 0) {
      invoice.status = 'Partial';

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
    const { startDate, endDate, type, payment_method } = req.query;

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

    const paymentMethodBreakdown = await Invoice.aggregate([
      { $match: filter },
      { $unwind: '$payment_history' },
      {
        $group: {
          _id: '$payment_history.method',
          amount: { $sum: '$payment_history.amount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { amount: -1 } }
    ]);

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

    const radiologyStats = await Invoice.aggregate([
      { $match: { ...filter, has_radiology: true } },
      { $unwind: '$radiology_items' },
      {
        $group: {
          _id: '$radiology_items.status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$radiology_items.total_price' }
        }
      }
    ]);

    const radiologyRevenue = await Invoice.aggregate([
      { $match: { ...filter, invoice_type: 'Radiology' } },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }
    ]);

    res.json({
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      paidRevenue: paidRevenue[0]?.total || 0,
      pendingRevenue: (totalRevenue[0]?.total || 0) - (paidRevenue[0]?.total || 0),
      revenueByType,
      statusCounts,
      byPaymentMethod: paymentMethodBreakdown.map(item => ({
        method: item._id,
        amount: item.amount,
        count: item.count
      })),
      procedureStats,
      procedureRevenue: procedureRevenue[0]?.total || 0,
      procedureCount: procedureRevenue[0]?.count || 0,
      labTestStats,
      labTestRevenue: labTestRevenue[0]?.total || 0,
      labTestCount: labTestRevenue[0]?.count || 0,
      radiologyStats,
      radiologyRevenue: radiologyRevenue[0]?.total || 0,
      radiologyCount: radiologyRevenue[0]?.count || 0
    });
  } catch (err) {
    console.error('Error fetching invoice statistics:', err);
    res.status(500).json({ error: err.message });
  }
};

// Export invoices
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

// Download invoice PDF
exports.downloadInvoicePDF = async (req, res) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id)
      .populate('patient_id', 'first_name last_name phone address')
      .populate('appointment_id', 'appointment_date type')
      .populate('prescription_id', 'prescription_number diagnosis')
      .populate('procedure_items.performed_by', 'firstName lastName')
      .populate('lab_test_items.performed_by', 'firstName lastName')
      .populate('radiology_items.performed_by', 'firstName lastName')
      .populate('radiology_items.reported_by', 'firstName lastName')
      .populate('medicine_items.medicine_id', 'name generic_name')
      .populate('medicine_items.batch_id', 'batch_number expiry_date');

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);

    doc.pipe(res);

    addHeader(doc);
    addInvoiceDetails(doc, invoice);
    addCustomerDetails(doc, invoice);

    if (invoice.invoice_type === 'Procedure' || invoice.procedure_items.length > 0) {
      addProcedureItemsTable(doc, invoice);
    } else if (invoice.invoice_type === 'Lab Test' || (invoice.lab_test_items && invoice.lab_test_items.length > 0)) {
      addLabTestItemsTable(doc, invoice);
    } else if (invoice.invoice_type === 'Radiology' || (invoice.radiology_items && invoice.radiology_items.length > 0)) {
      addRadiologyItemsTable(doc, invoice);
    } else if (invoice.invoice_type === 'Pharmacy') {
      addMedicineItemsTable(doc, invoice);
    } else {
      addServiceItemsTable(doc, invoice);
    }

    addFooter(doc, invoice);

    doc.end();

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
};

// PDF Helper Functions
function addHeader(doc) {
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

  doc.text('Invoice Number:', leftCol, y);
  doc.text(invoice.invoice_number, leftCol + 100, y);
  doc.text('Invoice Date:', leftCol, y + 15);
  doc.text(new Date(invoice.issue_date).toLocaleDateString(), leftCol + 100, y + 15);
  doc.text('Due Date:', leftCol, y + 30);
  doc.text(new Date(invoice.due_date).toLocaleDateString(), leftCol + 100, y + 30);

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

  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  invoice.procedure_items.forEach((item) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
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

    const status = item.status || 'Pending';
    const statusColors = { 'Completed': '#10B981', 'In Progress': '#3B82F6', 'Scheduled': '#8B5CF6', 'Pending': '#EF4444' };
    doc.fillColor(statusColors[status] || '#6B7280');
    doc.text(status, x, y);
    doc.fillColor('#000000');
    y += 20;
  });

  invoice.service_items.forEach((item) => {
    if (y > 700) { doc.addPage(); y = 50; }
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
}

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
    if (y > 700) { doc.addPage(); y = 50; }
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
    const statusColors = { 'Completed': '#10B981', 'In Progress': '#3B82F6', 'Scheduled': '#8B5CF6', 'Sample Collected': '#F59E0B', 'Pending': '#EF4444' };
    doc.fillColor(statusColors[status] || '#6B7280');
    doc.text(status, x, y);
    doc.fillColor('#000000');
    y += 20;
  });
}

function addRadiologyItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Test Name', 'Category', 'Qty', 'Unit Price', 'Amount', 'Status'];
  const colWidths = [50, 150, 80, 40, 70, 70, 70];
  let x = 50;

  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  (invoice.radiology_items || []).forEach((item) => {
    if (y > 700) { doc.addPage(); y = 50; }
    x = 50;
    doc.text(item.imaging_test_code || 'RD', x, y);
    x += colWidths[0];
    doc.text((item.imaging_test_name || 'Radiology Test').substring(0, 20), x, y, { width: colWidths[1] - 5 });
    x += colWidths[1];
    doc.text(item.category || 'General', x, y, { width: colWidths[2] - 5 });
    x += colWidths[2];
    doc.text((item.quantity || 1).toString(), x, y);
    x += colWidths[3];
    doc.text(`₹${Number(item.unit_price || 0).toFixed(2)}`, x, y);
    x += colWidths[4];
    doc.text(`₹${Number(item.total_price || 0).toFixed(2)}`, x, y);
    x += colWidths[5];

    const status = item.status || 'Pending';
    const statusColors = { 'Reported': '#10B981', 'Completed': '#10B981', 'In Progress': '#3B82F6', 'Scheduled': '#8B5CF6', 'Approved': '#8B5CF6', 'Pending': '#EF4444' };
    doc.fillColor(statusColors[status] || '#6B7280');
    doc.text(status, x, y);
    doc.fillColor('#000000');
    y += 20;
  });
}

function addMedicineItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Description', 'Batch', 'Qty', 'Unit Price', 'Amount'];
  const colWidths = [60, 180, 70, 50, 80, 80];
  let x = 50;

  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  invoice.medicine_items.forEach((item) => {
    if (y > 700) { doc.addPage(); y = 50; }
    x = 50;
    doc.text(item.batch_id?.batch_number?.slice(-4) || 'N/A', x, y);
    x += colWidths[0];
    const medName = item.medicine_name || (item.medicine_id?.name || 'Medicine');
    doc.text(medName, x, y, { width: colWidths[1] - 10 });
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
}

function addServiceItemsTable(doc, invoice) {
  const tableTop = 340;
  const headers = ['Code', 'Description', 'Qty', 'Unit Price', 'Amount'];
  const colWidths = [60, 250, 50, 90, 90];
  let x = 50;

  doc.fontSize(10).font('Helvetica-Bold');
  headers.forEach((header, i) => {
    doc.text(header, x, tableTop);
    x += colWidths[i];
  });

  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();

  let y = tableTop + 30;
  doc.fontSize(9).font('Helvetica');

  invoice.service_items.forEach((item) => {
    if (y > 700) { doc.addPage(); y = 50; }
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
}

function addFooter(doc, invoice) {
  const footerY = 650;
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

  const statusColors = { 'Paid': '#10B981', 'Partial': '#3B82F6', 'Pending': '#EF4444', 'Overdue': '#DC2626' };
  doc.fillColor(statusColors[invoice.status] || '#6B7280');
  doc.text(`Status: ${invoice.status}`, 50, footerY + 80);
  doc.fillColor('#000000');

  doc.fontSize(8).text('Thank you for choosing our services!', 50, 750, { align: 'center' });
  doc.text('This is a computer generated invoice and does not require a physical signature.', 50, 765, { align: 'center' });
  doc.text('For any queries, please contact our billing department.', 50, 780, { align: 'center' });

  if (invoice.has_procedures) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Procedures Status: ${invoice.procedures_status}`, 50, 800);
    if (invoice.procedure_items && invoice.procedure_items.length > 0) {
      const pendingCount = invoice.procedure_items.filter(p => p.status === 'Pending').length;
      const completedCount = invoice.procedure_items.filter(p => p.status === 'Completed').length;
      doc.text(`Pending: ${pendingCount} | Completed: ${completedCount} | Total: ${invoice.procedure_items.length}`, 50, 815);
    }
  }

  if (invoice.has_lab_tests) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Lab Tests Status: ${invoice.lab_tests_status}`, 50, 835);
    if (invoice.lab_test_items && invoice.lab_test_items.length > 0) {
      const pendingCount = invoice.lab_test_items.filter(t => t.status === 'Pending').length;
      const completedCount = invoice.lab_test_items.filter(t => t.status === 'Completed').length;
      doc.text(`Pending: ${pendingCount} | Completed: ${completedCount} | Total: ${invoice.lab_test_items.length}`, 50, 850);
    }
  }

  if (invoice.has_radiology) {
    doc.moveDown(2);
    doc.fontSize(9).text(`Radiology Status: ${invoice.radiology_status}`, 50, 870);
    if (invoice.radiology_items && invoice.radiology_items.length > 0) {
      const pendingCount = invoice.radiology_items.filter(r => r.status === 'Pending' || r.status === 'Approved' || r.status === 'Scheduled').length;
      const reportedCount = invoice.radiology_items.filter(r => r.status === 'Reported' || r.status === 'Completed').length;
      doc.text(`Pending: ${pendingCount} | Reported: ${reportedCount} | Total: ${invoice.radiology_items.length}`, 50, 885);
    }
  }
}