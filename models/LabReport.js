const mongoose = require('mongoose');

const labReportSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  report_type: { type: String, required: true },
  file_url: { type: String }, // URL to uploaded file
  report_date: { type: Date, required: true },
  notes: { type: String }
});

module.exports = mongoose.model('LabReport', labReportSchema);
