const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const { DEFAULT_HOSPITAL_TIME_ZONE, hospitalDateKey, dateKeyToStorageDate } = require('../utils/hospitalDateTime');

const appointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  department_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  appointment_date: { type: Date, required: true },
  appointment_date_key: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  scheduled_timezone: { type: String, default: DEFAULT_HOSPITAL_TIME_ZONE },
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
      default: operationNow
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

  visit_mode: {
    type: String,
    enum: ['physical', 'teleconsultation', 'homecare'],
    default: 'physical',
    index: true
  },
  homecare: {
    serviceType: { type: String, trim: true },
    address: { type: String, trim: true },
    scheduledWindowStart: Date,
    scheduledWindowEnd: Date,
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deliveryStatus: { type: String, enum: ['scheduled', 'en_route', 'delivered', 'completed', 'cancelled'], default: 'scheduled' },
    deliveredAt: Date,
    completionNote: { type: String, trim: true },
    feedback: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true },
      submittedAt: Date
    }
  },
  teleconsultation: {
    communicationMode: {
      type: String,
      enum: ['video', 'phone', 'chat', 'not_applicable'],
      default: 'not_applicable'
    },
    meetingUrl: { type: String, trim: true },
    meetingReference: { type: String, trim: true },
    consentCaptured: { type: Boolean, default: false },
    consentCapturedAt: Date,
    consentCapturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  attachments: [{
    name: String,
    url: String,
    mimeType: String,
    addedAt: { type: Date, default: Date.now },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  externalBooking: {
    system: { type: String, trim: true },
    externalAppointmentId: { type: String, trim: true },
    sourceUpdatedAt: Date,
    lastSyncedAt: Date,
    rawPayload: mongoose.Schema.Types.Mixed
  },
  notificationDeliveryIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'NotificationDelivery'
  }],
  lifecycleTimestamps: {
    bookedAt: { type: Date, default: operationNow },
    checkedInAt: Date,
    consultationStartedAt: Date,
    consultationEndedAt: Date,
    cancelledAt: Date
  },
  queuePosition: { type: Number, min: 1 },
  estimatedWaitMinutes: { type: Number, min: 0 },
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

appointmentSchema.index(
  { hospital_id: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } }
  }
);
appointmentSchema.index({ hospital_id: 1, bookingFingerprint: 1, created_at: -1 });
appointmentSchema.index(
  { hospital_id: 1, 'externalBooking.system': 1, 'externalBooking.externalAppointmentId': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'externalBooking.system': { $type: 'string' },
      'externalBooking.externalAppointmentId': { $type: 'string' }
    }
  }
);
appointmentSchema.index({ hospital_id: 1, appointment_date: 1, department_id: 1, status: 1 });
appointmentSchema.index({ hospital_id: 1, appointment_date_key: 1, department_id: 1, status: 1 });

appointmentSchema.pre('validate', function normalizeAppointmentDate(next) {
  try {
    const timeZone = this.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const key = this.appointment_date_key || hospitalDateKey(this.appointment_date, timeZone);
    this.appointment_date_key = key;
    this.appointment_date = dateKeyToStorageDate(key);
    this.scheduled_timezone = timeZone;
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Appointment', appointmentSchema);
