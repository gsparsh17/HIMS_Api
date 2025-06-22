const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  dateOfBirth: { type: Date },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  zipCode: { type: String },
  role: { type: String, enum: ['Doctor', 'Nurse', 'Technician', 'Administrator'] },
  department: { type: String }, // Can be changed to ObjectId if needed
  specialization: { type: String },
  licenseNumber: { type: String, required: true, unique: true },
  experience: { type: Number },
  education: { type: String },
  shift: { type: String },
  emergencyContact: { type: String },
  emergencyPhone: { type: String },
  startDate: { type: Date },
  salary: { type: Number },
  isFullTime: { type: Boolean, default: true },
  hasInsurance: { type: Boolean, default: true },
  notes: { type: String },
  joined_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Doctor', doctorSchema);
