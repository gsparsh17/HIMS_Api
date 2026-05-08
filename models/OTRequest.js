const mongoose = require('mongoose');

const otRequestSchema = new mongoose.Schema({
  requestNumber: {
    type: String,
    unique: true,
    required: true
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
  
  // Status Tracking
  status: {
    type: String,
    enum: [
      'Requested',
      'Approved',
      'Scheduled',
      'In Progress',
      'Completed',
      'Cancelled',
      'Postponed'
    ],
    default: 'Requested'
  },
  
  // Timeline
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  startedAt: Date,
  completedAt: Date,
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
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Generate request number
otRequestSchema.pre('validate', async function(next) {
  if (this.isNew && !this.requestNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('OTRequest').countDocuments();
    this.requestNumber = `OT-${year}${month}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

// Indexes
otRequestSchema.index({ admissionId: 1, status: 1 });
otRequestSchema.index({ patientId: 1 });
otRequestSchema.index({ doctorId: 1 });
otRequestSchema.index({ requestedDate: -1 });
otRequestSchema.index({ scheduledDate: 1 });
otRequestSchema.index({ otRoomId: 1 });

module.exports = mongoose.model('OTRequest', otRequestSchema);