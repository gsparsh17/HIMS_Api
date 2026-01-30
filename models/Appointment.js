const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  appointment_date: { type: Date, required: true },
  start_time: Date, // For time-based appointments
  end_time: Date,   // For time-based appointments
  serial_number: Number, // For number-based appointments
  type: { 
    type: String,
    enum: ['time-based', 'number-based'],
    required: true
  },
  appointment_type: {
    type: String,
    enum: ['consultation', 'follow-up', 'checkup', 'procedure', 'surgery', 'emergency'],
    required: true
  },
  priority: {
    type: String,
    enum: ['Low', 'Normal', 'High', 'Urgent'],
    default: 'Normal'
  },
  notes: { type: String },
  status: {
    type: String,
    enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'],
    default: 'Scheduled'
  },
  created_at: { type: Date, default: Date.now },
  actual_start_time: Date, // When the appointment actually started
  actual_end_time: Date,   // When the appointment actually ended
  duration: Number        // Actual duration in minutes
});

module.exports = mongoose.model('Appointment', appointmentSchema);