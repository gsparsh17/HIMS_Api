const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  gender: { type: String, enum: ['Male', 'Female', 'Other'], required: true },
  dob: { type: Date, required: true },
  address: { type: String },
  emergency_contact: { type: String },
  registered_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Patient', patientSchema);
