const mongoose = require('mongoose');

const radiologySectionSchema = new mongoose.Schema({
  key: { type: String, trim: true },
  label: { type: String, required: true, trim: true },
  text: { type: String, default: '' }
}, { _id: false });

const radiologyImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String, trim: true },
  caption: { type: String, trim: true },
  fileName: { type: String, trim: true },
  mimeType: { type: String, trim: true },
  fileSize: { type: Number, min: 0 }
}, { _id: false });

const manualRadiologyReportSchema = new mongoose.Schema({
  templateId: { type: String, required: true, trim: true },
  templateNumber: Number,
  templateVersion: { type: String, trim: true },
  templateName: { type: String, required: true, trim: true },
  sections: [radiologySectionSchema],
  tables: { type: mongoose.Schema.Types.Mixed, default: [] },
  images: [radiologyImageSchema],
  radiologistName: { type: String, trim: true },
  technicianName: { type: String, trim: true },
  disclaimer: { type: String, trim: true },
  reportedAt: { type: Date, default: Date.now },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const radiologyRequestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  requestNumber: {
    type: String,
  },
  
  // Source context
  sourceType: {
    type: String,
    enum: ['OPD', 'IPD', 'Emergency'],
    required: true,
    default: 'IPD'
  },
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
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
  
  // Imaging test details
  imagingTestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImagingTest',
    required: true
  },
  testCode: {
    type: String,
    required: true
  },
  testName: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  reportTemplateId: {
    type: String,
    trim: true,
    index: true
  },
  reportTemplateName: {
    type: String,
    trim: true
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
  
  // Status tracking
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Scheduled', 'In Progress', 'Completed', 'Result Entered', 'Verified', 'Reported', 'Amended', 'Cancelled'],
    default: 'Pending'
  },
  
  // Workflow tracking
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RadiologyStaff'
  },
  approvedAt: {
    type: Date
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RadiologyStaff'
  },
  performedAt: {
    type: Date
  },
  reportedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RadiologyStaff'
  },
  reportedAt: {
    type: Date
  },
  
  // Results
  findings: {
    type: String,
    trim: true
  },
  impression: {
    type: String,
    trim: true
  },
  report_url: {
    type: String
  },
  public_id: {
    type: String
  },
  report_mode: {
    type: String,
    enum: ['uploaded', 'manual']
  },
  report_file_name: { type: String, trim: true },
  report_mime_type: { type: String, trim: true },
  report_file_size: { type: Number, min: 0 },
  manual_report: manualRadiologyReportSchema,
  
  // Notes
  technician_notes: {
    type: String,
    trim: true
  },
  radiologist_notes: {
    type: String,
    trim: true
  },
  patient_notes: {
    type: String,
    trim: true
  },
  
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
  
  // External lab (for referred out)
  is_referred_out: {
    type: Boolean,
    default: false
  },
  external_facility: {
    name: { type: String, trim: true },
    address: { type: String, trim: true },
    contact_person: { type: String, trim: true },
    contact_phone: { type: String, trim: true }
  },
  external_reference_number: {
    type: String,
    trim: true
  },
  external_report_url: {
    type: String
  },
  

  abdmRecordLink: {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaNumber: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: { type: String, enum: ['pending_abha', 'linked', 'ready_for_consent', 'shared', 'LOCAL_RECORD_READY', 'VERIFICATION_PENDING', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'], default: 'pending_abha' },
    linkedAt: Date,
    source: String,
    ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' }
  },
  modality: { type: String, trim: true, index: true },
  scheduledStart: Date,
  scheduledEnd: Date,
  assignedTechnician: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedRadiologist: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  contrastRequired: { type: Boolean, default: false },
  patientPreparation: {
    instructions: String,
    status: { type: String, enum: ['not_required', 'pending', 'complete', 'failed'], default: 'pending' },
    completedAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  safetyChecklist: {
    pregnancyChecked: Boolean,
    renalFunctionChecked: Boolean,
    allergyChecked: Boolean,
    implantChecked: Boolean,
    contrastConsentChecked: Boolean,
    notes: String,
    completedAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  resultEnteredAt: Date,
  verifiedAt: Date,
  verifiedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedAt: Date,
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amendmentVersion: { type: Number, default: 0 },
  amendments: [{
    version: Number,
    reason: String,
    amendedAt: Date,
    amendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    previousReport: mongoose.Schema.Types.Mixed
  }],
  workflowHistory: [{
    from: String,
    to: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String
  }],
  turnaroundDueAt: Date,
  payerContext: {
    coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage' },
    payerName: String,
    preAuthStatus: String
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate request number before save
radiologyRequestSchema.pre('save', async function(next) {
  if (this.isNew && !this.requestNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('RadiologyRequest').countDocuments({ hospitalId: this.hospitalId, requestedDate: { $gte: new Date(year, date.getMonth(), 1), $lt: new Date(year, date.getMonth() + 1, 1) } });
    const sequence = String(count + 1).padStart(4, '0');
    this.requestNumber = `RAD-${year}${month}-${sequence}`;
  }
  next();
});

// Virtual for source type display
radiologyRequestSchema.virtual('sourceDisplay').get(function() {
  if (this.sourceType === 'IPD' && this.admissionId) {
    return `IPD Admission: ${this.admissionId}`;
  }
  return this.sourceType;
});

// Indexes
radiologyRequestSchema.index({ hospitalId: 1, patientId: 1, requestedDate: -1 });
radiologyRequestSchema.index({ doctorId: 1, status: 1 });
radiologyRequestSchema.index({ status: 1, scheduledDate: 1 });
radiologyRequestSchema.index({ hospitalId: 1, requestNumber: 1 }, { unique: true });
radiologyRequestSchema.index({ admissionId: 1, sourceType: 'IPD' });
radiologyRequestSchema.index({ 'abdmRecordLink.abhaNumber': 1 });
radiologyRequestSchema.index({ 'abdmRecordLink.abhaAddress': 1 });

module.exports = mongoose.model('RadiologyRequest', radiologyRequestSchema);