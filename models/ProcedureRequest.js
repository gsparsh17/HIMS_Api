const mongoose = require('mongoose');

const procedureRequestSchema = new mongoose.Schema({
  requestNumber: {
    type: String,
    unique: true
  },
  
  // Source context (OPD or IPD)
  sourceType: {
    type: String,
    enum: ['OPD', 'IPD', 'Emergency'],
    required: true,
    default: 'IPD'
  },
  
  // For IPD admissions
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },
  
  // For OPD appointments
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  
  // For prescription linkage
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  
  // Patient and doctor info
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
  
  // Procedure details
  procedureId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Procedure',
    required: true
  },
  procedureCode: {
    type: String,
    required: true
  },
  procedureName: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  subcategory: {
    type: String
  },
  
  // Clinical information
  clinical_indication: {
    type: String,
    trim: true
  },
  clinical_history: {
    type: String,
    trim: true
  },
  priority: {
    type: String,
    enum: ['Routine', 'Urgent', 'Emergency'],
    default: 'Routine'
  },
  
  // Scheduling
  requestedDate: {
    type: Date,
    default: Date.now
  },
  scheduledDate: {
    type: Date
  },
  
  // Procedure specific fields
  estimated_duration_minutes: {
    type: Number,
    default: 30
  },
  
  // Anesthesia
  anesthesia_type: {
    type: String,
    enum: ['Local', 'Regional', 'General', 'Sedation', 'None'],
    default: 'Local'
  },
  
  // Pre-procedure requirements
  fasting_required: {
    type: Boolean,
    default: false
  },
  pre_procedure_instructions: {
    type: String,
    trim: true
  },
  
  // Consent
  consent_obtained: {
    type: Boolean,
    default: false
  },
  consent_form_url: {
    type: String
  },
  consent_obtained_at: {
    type: Date
  },
  consent_obtained_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Postponed'],
    default: 'Pending'
  },
  
  // Workflow tracking
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  performedAt: {
    type: Date
  },
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  completedAt: {
    type: Date
  },
  
  // Results and notes
  findings: {
    type: String,
    trim: true
  },
  complications: {
    type: String,
    trim: true
  },
  post_procedure_instructions: {
    type: String,
    trim: true
  },
  surgeon_notes: {
    type: String,
    trim: true
  },
  anesthesiologist_notes: {
    type: String,
    trim: true
  },
  
  // Attachments
  attachments: [{
    name: String,
    url: String,
    uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploaded_at: { type: Date, default: Date.now }
  }],
  
  // Billing
  cost: {
    type: Number,
    default: 0
  },
  is_billed: {
    type: Boolean,
    default: false
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  
  // Cancellation
  cancellation_reason: {
    type: String,
    trim: true
  },
  cancelled_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  cancelled_at: {
    type: Date
  },
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate request number before save
procedureRequestSchema.pre('save', async function(next) {
  if (this.isNew && !this.requestNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('ProcedureRequest').countDocuments();
    const sequence = String(count + 1).padStart(4, '0');
    this.requestNumber = `PROC-${year}${month}-${sequence}`;
  }
  next();
});

// Virtual for source display
procedureRequestSchema.virtual('sourceDisplay').get(function() {
  if (this.sourceType === 'IPD' && this.admissionId) {
    return `IPD - Admission: ${this.admissionId}`;
  }
  if (this.sourceType === 'OPD' && this.appointmentId) {
    return `OPD - Appointment: ${this.appointmentId}`;
  }
  return this.sourceType;
});

// Indexes
procedureRequestSchema.index({ patientId: 1, requestedDate: -1 });
procedureRequestSchema.index({ doctorId: 1, status: 1 });
procedureRequestSchema.index({ status: 1, scheduledDate: 1 });
procedureRequestSchema.index({ requestNumber: 1 });
procedureRequestSchema.index({ admissionId: 1, sourceType: 1 });
procedureRequestSchema.index({ appointmentId: 1, sourceType: 1 });
procedureRequestSchema.index({ procedureCode: 1 });

module.exports = mongoose.model('ProcedureRequest', procedureRequestSchema);