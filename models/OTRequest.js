const mongoose = require('mongoose');

const otRequestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  encounterType: { type: String, enum: ['IPD', 'OPD', 'Emergency'], default: 'IPD' },
  encounterId: { type: mongoose.Schema.Types.ObjectId, index: true },
  version: { type: Number, default: 1, min: 1 },
  workflowPolicyVersion: { type: String, default: 'ot-v1' },
  readinessStatus: { type: String, enum: ['Not Evaluated', 'Pending', 'Ready', 'Ready With Bypass'], default: 'Not Evaluated', index: true },
  clinicalClosureStatus: { type: String, enum: ['Open', 'Pending Documents', 'Closed'], default: 'Open' },
  inventoryClosureStatus: { type: String, enum: ['Not Required', 'Pending', 'Reconciled'], default: 'Not Required' },
  billingClosureStatus: { type: String, enum: ['Pending', 'Cleared', 'Exception Approved'], default: 'Pending' },
  emergencyOverride: {
    enabled: { type: Boolean, default: false },
    reason: String,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date
  },
  requestNumber: {
    type: String,
    required: true,
    index: true
  },
  
  // Source References
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission',
    required: true,
    index: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },
  
  // Procedure Details
  procedureId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Procedure'
  },
  procedureCode: {
    type: String,
    required: true
  },
  procedureName: {
    type: String,
    required: true
  },
  procedureCategory: String,
  
  // Clinical Information
  clinical_indication: String,
  clinical_history: String,
  urgency: {
    type: String,
    enum: ['Elective', 'Urgent', 'Emergency'],
    default: 'Elective'
  },
  special_instructions: String,
  
  // Scheduling
  requestedDate: {
    type: Date,
    default: Date.now
  },
  preferredDate: Date,
  preferredTime: String,
  
  // OT Assignment
  otRoomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room'
  },
  scheduledDate: Date,
  scheduledTime: String,
  scheduledStart: Date,
  scheduledEnd: Date,
  setupBufferMinutes: { type: Number, default: 15 },
  cleaningBufferMinutes: { type: Number, default: 20 },
  estimated_duration_minutes: {
    type: Number,
    default: 60
  },
  
  // Team Assignment
  primarySurgeonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  assistantSurgeonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  anesthetistId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  scrubNurseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  circulatingNurseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Nurse'
  },
  otStaffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OTStaff'
  },
  
  // Status Tracking - UPDATED with payment status
  status: {
    type: String,
    enum: [
      'Requested',
      'Readiness Pending',
      'Payment Pending',
      'Payment Received',
      'Approved',
      'Scheduled',
      'Patient Received',
      'In Progress',
      'Recovery',
      'Transferred',
      'Closed',
      'Completed',
      'Cancelled',
      'Postponed'
    ],
    default: 'Requested'
  },
  
  // Payment Tracking - NEW FIELDS
  paymentStatus: {
    type: String,
    enum: ['Pending', 'Partial', 'Completed', 'Refunded', 'Not Required'],
    default: 'Pending'
  },
  paymentAmount: {
    type: Number,
    default: 0
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  dueAmount: {
    type: Number,
    default: 0
  },
  billId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bill'
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  paymentReceivedAt: Date,
  paymentReceivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Timeline
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  startedAt: Date,
  completedAt: Date,
  patientReceivedAt: Date,
  recoveryStartedAt: Date,
  transferredAt: Date,
  closedAt: Date,
  postponedAt: Date,
  postponementReason: String,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
  cancellationReason: String,
  
  // Surgical Findings
  findings: String,
  complications: String,
  procedure_performed: String,
  blood_loss_ml: { type: Number, default: 0 },
  anesthesia_notes: String,
  surgeon_notes: String,
  
  // Post-Operative
  post_op_diagnosis: String,
  post_op_instructions: String,
  post_op_wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  post_op_roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  post_op_bedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed' },
  transferred_to_ward: { type: Boolean, default: false },
  transferred_at: Date,
  
  // Consumables & Implants
  consumables: [{
    item_name: String,
    quantity: Number,
    unit_price: Number,
    total_price: Number
  }],
  implants: [{
    implant_name: String,
    serial_number: String,
    quantity: Number,
    unit_price: Number,
    total_price: Number
  }],
  
  // Attachments
  consent_form_url: String,
  surgery_report_url: String,
  attachments: [{
    name: String,
    url: String,
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploaded_at: Date
  }],
  
  // Billing
  estimated_cost: { type: Number, default: 0 },
  total_cost: { type: Number, default: 0 },
  is_billed: { type: Boolean, default: false },
  
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Calculate due amount before save
otRequestSchema.pre('save', function(next) {
  this.total_cost = Math.max(0, Number(this.total_cost || 0));
  this.paidAmount = Math.max(0, Number(this.paidAmount || 0));
  this.dueAmount = Math.max(0, this.total_cost - this.paidAmount);

  // Zero-value/insured cases may be explicitly marked as not requiring payment.
  if (this.paymentStatus === 'Not Required' && this.total_cost === 0) return next();
  if (this.paidAmount >= this.total_cost && this.total_cost > 0) {
    this.paymentStatus = 'Completed';
  } else if (this.paidAmount > 0) {
    this.paymentStatus = 'Partial';
  } else {
    this.paymentStatus = 'Pending';
  }

  next();
});

// Generate request number
otRequestSchema.pre('validate', async function(next) {
  try {
    if (this.isNew && !this.requestNumber) {
      if (!this.hospitalId) return next(new Error('hospitalId is required before generating an OT number'));
      const { nextSequence, financialYear } = require('../services/hospitalSequence.service');
      const sequence = await nextSequence(this.hospitalId, `OT:${financialYear()}`);
      this.requestNumber = `OT/${financialYear()}/${String(sequence).padStart(5, '0')}`;
    }
    if (!this.encounterId) this.encounterId = this.admissionId;
    next();
  } catch (error) {
    next(error);
  }
});

// Virtual for payment status
otRequestSchema.virtual('isPaymentComplete').get(function() {
  return this.paymentStatus === 'Completed' || this.paidAmount >= this.total_cost;
});

otRequestSchema.virtual('canSchedule').get(function() {
  return this.status === 'Payment Received' || (this.status === 'Approved' && this.isPaymentComplete);
});

// Indexes
otRequestSchema.index({ hospitalId: 1, requestNumber: 1 }, { unique: true });
otRequestSchema.index({ hospitalId: 1, admissionId: 1, status: 1 });
otRequestSchema.index({ hospitalId: 1, patientId: 1, requestedDate: -1 });
otRequestSchema.index({ hospitalId: 1, doctorId: 1, status: 1 });
otRequestSchema.index({ requestedDate: -1 });
otRequestSchema.index({ hospitalId: 1, scheduledStart: 1, scheduledEnd: 1 });
otRequestSchema.index({ hospitalId: 1, otRoomId: 1, scheduledStart: 1, scheduledEnd: 1 });
otRequestSchema.index({ paymentStatus: 1 });
otRequestSchema.index({ status: 1, paymentStatus: 1 });

module.exports = mongoose.model('OTRequest', otRequestSchema);