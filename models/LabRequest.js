const mongoose = require('mongoose');

const labObservationSchema = new mongoose.Schema({
  analyteCode: { type: String, trim: true },
  name: { type: String, required: true, trim: true },
  resultType: { type: String, enum: ['numeric', 'text'], default: 'text' },
  resultNumeric: { type: String, trim: true },
  resultText: { type: String, trim: true },
  comparator: { type: String, trim: true },
  printedFlag: { type: String, trim: true },
  derivedFlag: { type: String, trim: true },
  referenceLow: { type: String, trim: true },
  referenceHigh: { type: String, trim: true },
  referenceText: { type: String, trim: true },
  unit: { type: String, trim: true },
  method: { type: String, trim: true },
  instrument: { type: String, trim: true },
  comments: { type: String, trim: true }
}, { _id: false });

const labNarrativeSectionSchema = new mongoose.Schema({
  key: { type: String, trim: true },
  label: { type: String, required: true, trim: true },
  text: { type: String, default: '' },
  isDefault: { type: Boolean, default: false }
}, { _id: false });

const manualLabReportSchema = new mongoose.Schema({
  templateId: { type: String, trim: true },
  templateNumber: Number,
  templateVersion: { type: String, trim: true },
  templateName: { type: String, required: true, trim: true },
  specimenType: { type: String, trim: true },
  instrument: { type: String, trim: true },
  observations: [labObservationSchema],
  narrativeSections: [labNarrativeSectionSchema],
  additionalTables: { type: mongoose.Schema.Types.Mixed, default: [] },
  technicianNotes: { type: String, trim: true },
  pathologistNotes: { type: String, trim: true },
  disclaimer: { type: String, trim: true },
  reportedAt: { type: Date, default: Date.now },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });


const labRequestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  requestNumber: {
    type: String,
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
  
  // For prescription linkage (optional, for backward compatibility)
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
  
  // Lab test details
  labTestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabTest',
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
    enum: ['Routine', 'Urgent', 'Stat'],
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
  
  // Sample collection
  sample_collected_at: {
    type: Date
  },
  sample_collected_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabStaff'
  },
  sample_notes: {
    type: String,
    trim: true
  },
  
  // Processing
  processing_started_at: {
    type: Date
  },
  processing_completed_at: {
    type: Date
  },
  processed_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabStaff'
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Sample Collected', 'Received', 'Rejected', 'Processing', 'Result Entered', 'Verified', 'Completed', 'Reported', 'Amended', 'Cancelled', 'Referred Out'],
    default: 'Pending'
  },
  
  // Workflow approvals
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabStaff'
  },
  approvedAt: {
    type: Date
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabStaff'
  },
  verifiedAt: {
    type: Date
  },
  
  // Results
  result_value: {
    type: String,
    trim: true
  },
  result_interpretation: {
    type: String,
    trim: true
  },
  normal_range_used: {
    type: String,
    trim: true
  },
  is_abnormal: {
    type: Boolean,
    default: false
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
  manual_report: manualLabReportSchema,
  
  // Notes
  technician_notes: {
    type: String,
    trim: true
  },
  pathologist_notes: {
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
  external_lab_details: {
    lab_name: { type: String, trim: true },
    lab_address: { type: String, trim: true },
    contact_person: { type: String, trim: true },
    contact_phone: { type: String, trim: true },
    reference_number: { type: String, trim: true }
  },
  external_report_url: {
    type: String
  },
  external_report_received_at: {
    type: Date
  },
  
  accessionNumber: { type: String, trim: true, index: true },
  specimen: {
    type: { type: String, trim: true },
    container: String,
    barcode: String,
    fastingStatus: String,
    collectedAt: Date,
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt: Date,
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    condition: String
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedBench: String,
  collectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedAt: Date,
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resultEnteredAt: Date,
  verifierUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  releasedAt: Date,
  releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejection: {
    reasonCode: String,
    reason: String,
    rejectedAt: Date,
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  critical: {
    isCritical: { type: Boolean, default: false },
    flagReason: String,
    notifiedAt: Date,
    notifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    acknowledgements: [{
      recipientName: String,
      recipientRole: String,
      channel: String,
      acknowledgedAt: Date,
      acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      escalationLevel: Number,
      note: String
    }]
  },
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
labRequestSchema.pre('save', async function(next) {
  if (this.isNew && !this.requestNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('LabRequest').countDocuments({ hospitalId: this.hospitalId, requestedDate: { $gte: new Date(year, date.getMonth(), 1), $lt: new Date(year, date.getMonth() + 1, 1) } });
    const sequence = String(count + 1).padStart(4, '0');
    this.requestNumber = `LAB-${year}${month}-${sequence}`;
  }
  next();
});

// Virtual for source display
labRequestSchema.virtual('sourceDisplay').get(function() {
  if (this.sourceType === 'IPD' && this.admissionId) {
    return `IPD - Admission: ${this.admissionId}`;
  }
  if (this.sourceType === 'OPD' && this.appointmentId) {
    return `OPD - Appointment: ${this.appointmentId}`;
  }
  return this.sourceType;
});

// Check if result is abnormal based on normal range
labRequestSchema.methods.checkAbnormal = function(value) {
  // Implementation depends on your normal range format
  // This is a placeholder
  return false;
};

// Indexes
labRequestSchema.index({ hospitalId: 1, patientId: 1, requestedDate: -1 });
labRequestSchema.index({ doctorId: 1, status: 1 });
labRequestSchema.index({ status: 1, scheduledDate: 1 });
labRequestSchema.index({ hospitalId: 1, requestNumber: 1 }, { unique: true });
labRequestSchema.index({ admissionId: 1, sourceType: 1 });
labRequestSchema.index({ appointmentId: 1, sourceType: 1 });

module.exports = mongoose.model('LabRequest', labRequestSchema);