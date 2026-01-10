const mongoose = require('mongoose');

const vitalSchema = new mongoose.Schema({
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true
  },
  appointment_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment', // Added appointment_id
    required: true
  },
  prescription_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  recorded_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // Assumes you have a User model (or Staff/Nurse)
  },
  bp: {
    type: String,
    trim: true
  },
  weight: {
    type: String, // String to allow units like "70kg" or just number
    trim: true
  },
  pulse: {
    type: String,
    trim: true
  },
  spo2: {
    type: String,
    trim: true
  },
  temperature: {
    type: String,
    trim: true
  },
  recorded_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Vital', vitalSchema);
