const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  appointment_date: { type: Date, required: true },
  time_slot: { type: String, required: true }, // e.g., "10:00 AM - 10:30 AM"
  status: { 
    type: String, 
    enum: ['Scheduled', 'Completed', 'Cancelled'], 
    default: 'Scheduled' 
  },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Appointment', appointmentSchema);
