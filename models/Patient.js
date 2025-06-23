const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  gender: { type: String, enum: ['male', 'female', 'other'], required: true },
  dob: { type: Date, required: true },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zipCode: { type: String },
  emergency_contact: { type: String },
  emergency_phone: { type: String },
  medical_history: { type: String },
  allergies: { type: String },
  medications: { type: String },
  blood_group: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  },
  patient_type: {
    type: String,
    enum: ['OPD', 'IPD'],
    default: 'OPD',
  },
  registered_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Patient', patientSchema);
