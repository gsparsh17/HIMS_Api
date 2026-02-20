// controllers/labreport.controller.js
const LabReport = require('../models/LabReport');
const Prescription = require('../models/Prescription');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

exports.createLabReport = async (req, res) => {
  try {
    const report = new LabReport(req.body);
    await report.save();
    res.status(201).json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllLabReports = async (req, res) => {
  try {
    const reports = await LabReport.find()
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('prescription_id', 'prescription_number')
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getReportById = async (req, res) => {
  try {
    const report = await LabReport.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('prescription_id', 'prescription_number')
      .populate('lab_test_id', 'code name category');
    if (!report) return res.status(404).json({ error: 'Lab report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    await LabReport.findByIdAndDelete(req.params.id);
    res.json({ message: 'Lab report deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get reports by patient
exports.getReportsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const reports = await LabReport.find({ patient_id: patientId })
      .populate('doctor_id', 'firstName lastName')
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get reports by prescription
exports.getReportsByPrescription = async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    const reports = await LabReport.find({ prescription_id: prescriptionId })
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Upload report file
exports.uploadReport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { prescription_id, lab_test_id } = req.body;

    // Find prescription to get patient and doctor info
    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // Find the specific lab test in the prescription
    const labTest = prescription.recommendedLabTests.id(lab_test_id);
    if (!labTest) {
      return res.status(404).json({ error: 'Lab test not found in prescription' });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'lab_reports',
      resource_type: 'auto',
      public_id: `report_${prescription.prescription_number}_${lab_test_id}`
    });

    // Clean up local file
    fs.unlinkSync(req.file.path);

    // Create lab report record
    const report = new LabReport({
      patient_id: prescription.patient_id,
      doctor_id: prescription.doctor_id,
      prescription_id: prescription._id,
      lab_test_id: lab_test_id,
      report_type: labTest.lab_test_name,
      file_url: result.secure_url,
      public_id: result.public_id,
      report_date: new Date(),
      notes: req.body.notes || ''
    });

    await report.save();

    // Update the lab test in prescription with report URL
    labTest.report_url = result.secure_url;
    await prescription.save();

    res.status(201).json({
      success: true,
      message: 'Report uploaded successfully',
      file_url: result.secure_url,
      report
    });

  } catch (err) {
    console.error('Error uploading report:', err);
    // Clean up file if it exists
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
};