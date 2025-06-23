const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  department_id: { type: String, required: true }, // or ObjectId if you're referencing a Department model
  appointment_date: { type: Date, required: true },
  time_slot: { type: String, required: true },
  type: { 
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
    enum: ['Scheduled', 'Completed', 'Cancelled'],
    default: 'Scheduled'
  },
  created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Appointment', appointmentSchema);
