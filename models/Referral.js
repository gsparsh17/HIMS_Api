const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');
const { addSoftDeleteFields } = require('../utils/softDelete');

const referralSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  referralNumber: {
    type: String,
    trim: true,
    unique: true,
    sparse: true,
    default: () => `REF-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`
  },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  sourceAppointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true },
  targetAppointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  referringDoctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  referredDoctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  reason: { type: String, required: true, trim: true },
  clinicalSummary: { type: String, trim: true },
  priority: { type: String, enum: ['Routine', 'Urgent', 'STAT'], default: 'Routine' },
  referredAt: { type: Date, default: operationNow },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['Pending', 'Consulted', 'Cancelled'], default: 'Pending' }
}, {
  timestamps: true
});

addSoftDeleteFields(referralSchema);

module.exports = mongoose.model('Referral', referralSchema);
