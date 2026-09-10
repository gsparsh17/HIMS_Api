const { operationNow } = require('../utils/operationTimeContext');
const Invoice = require('../models/Invoice');
const Medicine = require('../models/Medicine');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const Pharmacy = require('../models/Pharmacy');
const Bill = require('../models/Bill');
const FinancialTransaction = require('../models/FinancialTransaction');
const Sale = require('../models/Sale');
const ProcedureRequest = require('../models/ProcedureRequest');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const PDFDocument = require('pdfkit');
const { default: mongoose } = require('mongoose');
const { requestHospitalId } = require('../utils/hospitalScope');
const { getHospitalPrintIdentity } = require('../services/hospitalPrintIdentity.service');
const { invoicePrintEnvelope } = require('../services/financeDocument.service');
const {
  COMPUTER_GENERATED_BILL_EN,
  COMPUTER_GENERATED_BILL_HI,
  formatDoctorName,
  resolveDepartmentName,
  registerDocumentFonts,
  useHindiFont
} = require('../utils/documentFormatters');

function invoiceScope(req, extra = {}) {
  const rawHospitalId = requestHospitalId(req);
  const hospitalId = rawHospitalId instanceof mongoose.Types.ObjectId
    ? rawHospitalId
    : new mongoose.Types.ObjectId(rawHospitalId);
  return {
    ...extra,
    hospital_id: hospitalId,
    is_deleted: { $ne: true }
  };
}

function invoiceDateRange(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/;
  const start = new Date(bareDate.test(String(startDate)) ? `${startDate}T00:00:00.000Z` : startDate);
  const end = new Date(bareDate.test(String(endDate)) ? `${endDate}T23:59:59.999Z` : endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { $gte: start, $lte: end };
}

// ============== PROCEDURE INVOICE FUNCTIONS ==============

// Generate invoice for procedures (using procedure_requests from prescription)
exports.generateProcedureInvoice = async (req, res) => {
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Procedure invoices are no longer created directly from browser/request totals. Post the clinical source charge through source-finance and issue the canonical patient invoice.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

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

    const filter = invoiceScope(req, { invoice_type: 'Procedure' });

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

    const invoice = await Invoice.findOne(invoiceScope(req, { _id: invoiceId }));
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (procedureIndex >= invoice.procedure_items.length) {
      return res.status(404).json({ error: 'Procedure not found in invoice' });
    }

    if (status) {
      invoice.procedure_items[procedureIndex].status = status;
      if (status === 'Completed') {
        invoice.procedure_items[procedureIndex].completed_date = completed_date || operationNow();
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
              prescription.procedure_requests[procIndex].completed_date = completed_date || operationNow();
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

    const filter = invoiceScope(req, { has_procedures: true });

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
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Lab invoices are no longer created directly from browser/request totals. Post the clinical source charge through source-finance and issue the canonical patient invoice.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

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

    const filter = invoiceScope(req, { invoice_type: 'Lab Test' });

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

    const invoice = await Invoice.findOne(invoiceScope(req, { _id: invoiceId }));
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!invoice.lab_test_items || labTestIndex >= invoice.lab_test_items.length) {
      return res.status(404).json({ error: 'Lab test not found in invoice' });
    }

    if (status) {
      invoice.lab_test_items[labTestIndex].status = status;
      if (status === 'Completed') {
        invoice.lab_test_items[labTestIndex].completed_date = completed_date || operationNow();
      }
      if (status === 'Sample Collected') {
        invoice.lab_test_items[labTestIndex].sample_collected_at = sample_collected_at || operationNow();
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
              prescription.lab_test_requests[testIndex].completed_date = completed_date || operationNow();
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

    const filter = invoiceScope(req, { has_lab_tests: true });

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
  return res.status(409).json({
    success: false,
    code: 'SOURCE_FINANCE_REQUIRED',
    error: 'Radiology invoices are no longer created directly from browser/request totals. Post the clinical source charge through source-finance and issue the canonical patient invoice.',
    canonicalChargeEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge',
    canonicalOpdInvoiceEndpoint: '/api/finance/patients/:patientId/invoices',
    canonicalIpdInvoiceEndpoint: '/api/finance/ipd/:admissionId/invoices'
  });
};

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

    const filter = invoiceScope(req, { invoice_type: 'Radiology' });

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

    const invoice = await Invoice.findOne(invoiceScope(req, { _id: invoiceId }));
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!invoice.radiology_items || radiologyIndex >= invoice.radiology_items.length) {
      return res.status(404).json({ error: 'Radiology test not found in invoice' });
    }

    if (status) {
      invoice.radiology_items[radiologyIndex].status = status;
      if (status === 'Reported' || status === 'Completed') {
        invoice.radiology_items[radiologyIndex].reported_at = reported_at || operationNow();
      }
      if (status === 'In Progress') {
        invoice.radiology_items[radiologyIndex].performed_at = performed_at || operationNow();
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

    const filter = invoiceScope(req, { has_radiology: true });

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
  // Legacy Finance invoice creation used browser unit prices/tax/discount and
  // independently decremented stock. That is no longer a monetary authority.
  // Pharmacy invoices are produced by the canonical POS sale transaction so
  // stock, pricing, tax, discount, payer allocation and settlement share one
  // idempotent source event.
  return res.status(409).json({
    success: false,
    code: 'PHARMACY_POS_REQUIRED',
    error: 'Direct pharmacy invoice creation is retired. Use Pharmacy POS quote/complete so hospital financial policy is applied server-side.',
    canonicalQuoteEndpoint: '/api/pharmacy/pos/quote',
    canonicalCompleteEndpoint: '/api/pharmacy/pos/complete'
  });
};

// Get pharmacy invoices
exports.getPharmacyInvoices = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;

    const filter = invoiceScope(req, { invoice_type: 'Pharmacy' });
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
    const now = operationNow();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const result = await Invoice.aggregate([
      {
        $match: {
          ...invoiceScope(req, { invoice_type: 'Pharmacy', status: 'Paid' }),
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
    const now = operationNow();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const result = await Invoice.aggregate([
      {
        $match: {
          ...invoiceScope(req, { invoice_type: 'Pharmacy', status: 'Paid' }),
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
  // This legacy endpoint accepted browser-computed item totals/discount/tax.
  // Keep it as an explicit compatibility guard; the canonical /billing
  // appointment branch resolves doctor tariff + financial policy, snapshots it
  // and uses encounter-linked idempotency.
  return res.status(409).json({
    success: false,
    code: 'CANONICAL_APPOINTMENT_BILLING_REQUIRED',
    error: 'Direct appointment invoice creation is retired. Use the canonical appointment billing workflow.',
    canonicalEndpoint: '/api/billing'
  });
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
      hospital_id: requestHospitalId(req),
      invoice_type: 'Purchase',
      customer_type: 'Supplier',
      customer_name: supplier.name,
      customer_phone: supplier.phone,
      customer_address: supplier.address,
      purchase_order_id: purchase_order_id,
      issue_date: operationNow(),
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

// ============== COMMON INVOICE FUNCTIONS ==============

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

    const filter = invoiceScope(req);

    if (status) {
      const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
      if (statuses.length === 1) filter.status = statuses[0];
      else if (statuses.length > 1) filter.status = { $in: statuses };
    }
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

    const issueDateRange = invoiceDateRange(startDate, endDate);
    if (issueDateRange) filter.issue_date = issueDateRange;

    const pipeline = [
      { $match: filter },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      { $unwind: { path: '$patient_info', preserveNullAndEmptyArrays: true } }
    ];

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
      pipeline.push({ $match: { 'patient_info.patient_type': patient_type } });
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
            _id: '$patient_info._id',
            first_name: '$patient_info.first_name',
            last_name: '$patient_info.last_name',
            patientId: '$patient_info.patientId',
            patient_type: '$patient_info.patient_type'
          },
          admission_id: 1,
          bill_id: 1,
          bill_ids: 1,
          document_stage: 1,
          customer_name: 1,
          customer_phone: 1,
          appointment_id: 1,
          collection_owner: 1,
          collection_mode: 1,
          collection_transferred_to_ipd: 1,
          collection_transferred_amount: 1
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

// Canonical patient-facing invoice print data. All print surfaces consume the
// same server envelope so browsers never reconstruct accounting totals.
exports.getInvoicePrintData = async (req, res) => {
  try {
    const data = await invoicePrintEnvelope({
      invoiceId: req.params.id,
      hospitalId: requestHospitalId(req)
    });
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Get invoice by ID
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findOne(invoiceScope(req, { _id: req.params.id }))
      .populate('patient_id')
      .populate({
        path: 'appointment_id',
        populate: [
          { path: 'doctor_id', select: 'firstName lastName specialization phone department' },
          { path: 'department_id', select: 'name code' }
        ]
      })
      .populate({
        path: 'admission_id',
        populate: [
          { path: 'primaryDoctorId', select: 'firstName lastName specialization' },
          { path: 'departmentId', select: 'name code' },
          { path: 'wardId', select: 'name wardNumber' },
          { path: 'bedId', select: 'bedNumber roomNumber' }
        ]
      })
      .populate('bill_id')
      .populate('bill_ids')
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

// ========== ENHANCED UPDATE INVOICE PAYMENT ==========
// This function handles payments for pharmacy invoices and properly updates
// all associated documents including Sale, Bill, Patient, and Ledger entries.
// It also handles deferred payments and advance consumption.
exports.updateInvoicePayment = async (req, res) => {
  try {
    const { amount, method, reference } = req.body;
    const { recordPharmacyOutstandingPayment } = require('../services/pharmacyTransaction.service');

    // Compatibility route only. Non-Pharmacy invoices must use the encounter
    // settlement APIs; Pharmacy outstanding collection is delegated to one
    // transactional service instead of mutating Invoice/Sale/Bill independently.
    const result = await recordPharmacyOutstandingPayment({
      invoiceId: req.params.id,
      amount,
      paymentMethod: method,
      reference,
      notes: req.body.notes,
      idempotencyKey: req.body.idempotencyKey || req.get?.('Idempotency-Key')
    }, req);

    return res.json({
      success: true,
      message: result.alreadyExists ? 'Payment already recorded' : 'Payment recorded successfully',
      receiptNumber: result.receiptNumber,
      transaction: result.transaction,
      invoice: result.invoice,
      bill: result.bill,
      sale: result.sale,
      balance_due: result.balanceAfter,
      alreadyExists: result.alreadyExists
    });
  } catch (err) {
    console.error('Error updating invoice payment:', err);
    return res.status(err.statusCode || 500).json({
      error: err.message,
      code: err.code
    });
  }
};

exports.getInvoicesByType = async (req, res) => {
  try {
    const { type } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const filter = invoiceScope(req, { invoice_type: type });
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
    const { startDate, endDate, type, invoice_type, status, payment_method } = req.query;

    const filter = invoiceScope(req);
    const issueDateRange = invoiceDateRange(startDate, endDate);
    if (issueDateRange) filter.issue_date = issueDateRange;
    const requestedType = type || invoice_type;
    if (requestedType) filter.invoice_type = requestedType;
    if (payment_method) filter['payment_history.method'] = payment_method;
    if (status) {
      const statuses = String(status).split(',').map((value) => value.trim()).filter(Boolean);
      if (statuses.length === 1) filter.status = statuses[0];
      else if (statuses.length > 1) filter.status = { $in: statuses };
    }

    const totalInvoices = await Invoice.countDocuments(filter);

    const financialTotals = await Invoice.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: { $ifNull: ['$total', 0] } },
          paidRevenue: { $sum: { $ifNull: ['$amount_paid', 0] } },
          pendingRevenue: { $sum: { $ifNull: ['$balance_due', 0] } }
        }
      }
    ]);
    const totals = financialTotals[0] || { totalRevenue: 0, paidRevenue: 0, pendingRevenue: 0 };

    const agingRows = await Invoice.find(filter).select('due_date balance_due').lean();
    const agingBreakdown = { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90_plus: 0 };
    let agingDaysTotal = 0;
    let agingDaysCount = 0;
    const now = Date.now();
    for (const row of agingRows) {
      const due = row.due_date ? new Date(row.due_date).getTime() : NaN;
      const balance = Math.max(0, Number(row.balance_due || 0));
      const days = Number.isFinite(due) ? Math.max(0, Math.ceil((now - due) / 86400000)) : 0;
      if (Number.isFinite(due)) {
        agingDaysTotal += days;
        agingDaysCount += 1;
      }
      if (days === 0) agingBreakdown.current += balance;
      else if (days <= 30) agingBreakdown.days1_30 += balance;
      else if (days <= 60) agingBreakdown.days31_60 += balance;
      else if (days <= 90) agingBreakdown.days61_90 += balance;
      else agingBreakdown.days90_plus += balance;
    }
    const averageAge = agingDaysCount ? Math.round(agingDaysTotal / agingDaysCount) : 0;

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
      totalRevenue: totals.totalRevenue || 0,
      paidRevenue: totals.paidRevenue || 0,
      pendingRevenue: totals.pendingRevenue || 0,
      averageAge,
      agingBreakdown,
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

    const filter = invoiceScope(req);
    const issueDateRange = invoiceDateRange(startDate, endDate);
    if (issueDateRange) filter.issue_date = issueDateRange;
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

    const invoice = await Invoice.findOne(invoiceScope(req, { _id: id }))
      .populate('patient_id', 'first_name last_name phone address patientId uhid')
      .populate('hospital_id', 'hospitalName name address city state pinCode contact phone email gst gst_number gstNumber licenseNumber license_number')
      .populate({
        path: 'appointment_id',
        select: 'appointment_date type doctor_id department_id',
        populate: [
          { path: 'doctor_id', select: 'salutation firstName lastName first_name last_name name department_id' },
          { path: 'department_id', select: 'name departmentName department_name' }
        ]
      })
      .populate({
        path: 'admission_id',
        select: 'primaryDoctorId departmentId admissionNumber admissionDate',
        populate: [
          { path: 'primaryDoctorId', select: 'salutation firstName lastName first_name last_name name department_id' },
          { path: 'departmentId', select: 'name departmentName department_name' }
        ]
      })
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

    const hospital = await getHospitalPrintIdentity({ includeLogoBuffer: true });
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    registerDocumentFonts(doc);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);

    doc.pipe(res);

    addHeader(doc, invoice, hospital);
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
function addHeader(doc, invoice, hospital) {
  const hospitalName = hospital.hospitalName;
  const address = hospital.hospitalAddress;
  const contact = hospital.hospitalContact;
  const registrations = [
    hospital.gstNumber || hospital.gst_number || hospital.gst ? `GSTIN: ${hospital.gstNumber || hospital.gst_number || hospital.gst}` : null,
    hospital.licenseNumber || hospital.license_number ? `License No: ${hospital.licenseNumber || hospital.license_number}` : null
  ].filter(Boolean).join(' | ');
  const logoBuffer = hospital._logoBuffer || hospital.logoBuffer;

  if (logoBuffer) {
    try { doc.image(logoBuffer, 50, 50, { fit: [48, 48], align: 'center', valign: 'center' }); } catch (_) { /* validated before rendering */ }
  }

  const textX = logoBuffer ? 105 : 50;
  const textWidth = logoBuffer ? 390 : 495;
  doc.fontSize(20).font('Helvetica-Bold').text(hospitalName, textX, 50, { width: textWidth, align: 'center' });
  doc.fontSize(12).font('Helvetica').text('Tax Invoice / Bill of Supply', textX, doc.y + 2, { width: textWidth, align: 'center' });
  if (address) doc.fontSize(9).text(address, textX, doc.y + 4, { width: textWidth, align: 'center' });
  if (contact) doc.fontSize(9).text(contact, textX, doc.y + 2, { width: textWidth, align: 'center' });
  if (registrations) doc.fontSize(9).text(registrations, textX, doc.y + 2, { width: textWidth, align: 'center' });
  doc.y = Math.max(doc.y + 8, 120);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
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
    doc.text(`Patient ID / UHID: ${invoice.patient_id.patientId || invoice.patient_id.uhid || 'N/A'}`, 50, 275);
    doc.text(`Phone: ${invoice.patient_id.phone || 'N/A'}`, 50, 290);
    doc.text(`Address: ${invoice.patient_id.address || 'N/A'}`, 50, 305, { width: 270 });
  } else {
    doc.text(`Name: ${invoice.customer_name || 'N/A'}`, 50, 260);
    doc.text(`Phone: ${invoice.customer_phone || 'N/A'}`, 50, 275);
  }

  const doctor = invoice.appointment_id?.doctor_id || invoice.admission_id?.primaryDoctorId;
  const department = invoice.appointment_id?.department_id || invoice.admission_id?.departmentId;
  doc.text(`Doctor / Consultant: ${formatDoctorName(doctor) || 'N/A'}`, 335, 260, { width: 210 });
  doc.text(`Department: ${resolveDepartmentName(department, doctor?.department_id) || 'N/A'}`, 335, 275, { width: 210 });
  if (invoice.admission_id?.admissionNumber) {
    doc.text(`Admission No: ${invoice.admission_id.admissionNumber}`, 335, 290, { width: 210 });
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
  const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const lineDiscount = n(invoice.line_discount_total);
  const billDiscount = n(invoice.bill_discount_total);
  const legacyDiscount = n(invoice.discount);
  const baseDiscount = lineDiscount || billDiscount ? lineDiscount + billDiscount : legacyDiscount;
  const settlementDiscount = n(invoice.settlement_discount_amount);
  const creditNotes = n(invoice.credit_note_total);
  const rounding = n(invoice.rounding_adjustment);
  const subtotal = n(invoice.subtotal ?? invoice.gross_amount);
  const tax = n(invoice.tax ?? invoice.tax_amount);
  const total = n(invoice.total ?? invoice.total_amount ?? (subtotal - baseDiscount + tax + rounding));
  const paid = n(invoice.amount_paid ?? invoice.paid_amount);
  const collectionTransferredToIpd =
    invoice.collection_owner === 'IPD' ||
    invoice.collection_mode === 'IPD_CONSOLIDATED' ||
    invoice.collection_transferred_to_ipd === true;
  const transferredAmount = n(
    invoice.collection_transferred_amount ||
    invoice.payer_allocation?.patient_liability ||
    invoice.total ||
    invoice.total_amount
  );
  const due = collectionTransferredToIpd
    ? 0
    : n(invoice.balance_due ?? Math.max(0, total - paid - settlementDiscount - creditNotes));
  const advanceApplied = n(invoice.advance_applied);
  const payer = invoice.payer_allocation || {};

  if (doc.y > 610) doc.addPage();
  const left = 305;
  const valueX = 455;
  let y = Math.max(doc.y + 16, 520);
  const row = (label, amount, options = {}) => {
    doc.fontSize(options.bold ? 10.5 : 9.5).font(options.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(label, left, y, { width: 140, align: 'right' });
    doc.text(`${options.negative ? '- ' : ''}₹${Math.abs(n(amount)).toFixed(2)}`, valueX, y, { width: 90, align: 'right' });
    y += 15;
  };

  row('Gross / Subtotal:', subtotal);
  if (baseDiscount > 0) row('Bill / Line Discount:', baseDiscount, { negative: true });
  if (tax !== 0) row('Tax / GST:', tax);
  if (rounding !== 0) row('Rounding Adjustment:', rounding);
  row('Net Invoice Amount:', total, { bold: true });
  if (settlementDiscount > 0) row('Final Settlement Discount:', settlementDiscount, { negative: true });
  if (creditNotes > 0) row('Credit Notes / Adjustments:', creditNotes, { negative: true });
  if (advanceApplied > 0) row('Advance Applied:', advanceApplied);
  if (collectionTransferredToIpd) {
    row('Transferred to IPD File:', transferredAmount);
    row('Pharmacy Counter Due:', 0, { bold: true });
  } else {
    row('Amount Paid / Settled:', paid);
    row('Balance Due:', due, { bold: true });
  }

  if (n(payer.standard_amount) || n(payer.contracted_amount) || n(payer.sponsor_liability)) {
    y += 5;
    row('Hospital Standard:', payer.standard_amount);
    row('Contracted Amount:', payer.contracted_amount);
    row('Sponsor Part:', payer.sponsor_liability);
    row('Patient Part:', payer.patient_liability);
    if (n(payer.non_admissible_amount) > 0) row('Non-admissible:', payer.non_admissible_amount);
    if (n(payer.contractual_adjustment) > 0) row('Contract Adjustment:', payer.contractual_adjustment);
    if (n(payer.hospital_concession) > 0) row('Hospital Concession:', payer.hospital_concession);
    if (n(payer.package_absorbed) > 0) row('Package Absorbed:', payer.package_absorbed);
  }

  const statusColors = { Paid: '#10B981', Partial: '#3B82F6', Pending: '#EF4444', Overdue: '#DC2626' };
  const displayStatus = collectionTransferredToIpd ? 'Transferred to IPD Billing' : (invoice.status || 'Issued');
  doc.fillColor(collectionTransferredToIpd ? '#2563EB' : (statusColors[invoice.status] || '#6B7280'));
  doc.fontSize(9).font('Helvetica-Bold').text(`Status: ${displayStatus}`, 50, Math.min(y + 5, 760));
  doc.fillColor('#000000');
  const footerY = Math.min(y + 30, 765);
  doc.fontSize(8).font('Helvetica').text(COMPUTER_GENERATED_BILL_EN, 50, footerY, { width: 495, align: 'center' });
  useHindiFont(doc);
  doc.fontSize(8).text(COMPUTER_GENERATED_BILL_HI, 50, footerY + 12, { width: 495, align: 'center' });
  doc.font('Helvetica');
}
