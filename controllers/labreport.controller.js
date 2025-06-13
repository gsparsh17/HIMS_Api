const LabReport = require('../models/LabReport');

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
    const reports = await LabReport.find().populate('patient_id').populate('doctor_id');
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getReportById = async (req, res) => {
  try {
    const report = await LabReport.findById(req.params.id).populate('patient_id').populate('doctor_id');
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


