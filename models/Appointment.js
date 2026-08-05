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
  cancellationReason: {
    type: String,
    trim: true
  },
  cancelledAt: Date,
  cancelledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancellationHistory: [{
    reason: {
      type: String,
      required: true,
      trim: true
    },
    cancelledAt: {
      type: Date,
      default: Date.now
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  created_at: { type: Date, default: Date.now },
  episodeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Episode',
    index: true
  },
  actual_start_time: Date, // When the appointment actually started
  actual_end_time: Date,   // When the appointment actually ended
  duration: Number,        // Actual duration in minutes
  token: { type: String, unique: false }, // OPD-YYYYMMDD-001 or IPD-YYYYMMDD-001

  idempotencyKey: { type: String, trim: true },
  bookingFingerprint: { type: String, trim: true, index: true },
  submissionSource: { type: String, trim: true, default: 'APPOINTMENT_MODAL' },
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  deskCheckoutId: { type: mongoose.Schema.Types.ObjectId, index: true },
  coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', index: true },
  sponsorType: { type: String, default: 'self' },
  sponsorName: { type: String, trim: true },

  abdmRecordLink: {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaNumber: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: { type: String, enum: ['pending_abha', 'linked', 'ready_for_consent', 'shared', 'LOCAL_RECORD_READY', 'VERIFICATION_PENDING', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'], default: 'pending_abha' },
    linkedAt: Date,
    source: String,
    ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' }
  },
});

appointmentSchema.index({ hospital_id: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
appointmentSchema.index({ hospital_id: 1, bookingFingerprint: 1, created_at: -1 });

module.exports = mongoose.model('Appointment', appointmentSchema);