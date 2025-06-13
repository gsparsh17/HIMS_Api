const mongoose = require('mongoose');

const prescriptionSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  diagnosis: { type: String },
  notes: { type: String },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Prescription', prescriptionSchema);
