const mongoose = require('mongoose');

const radiologyRequestSchema = new mongoose.Schema({
  requestNumber: {
    type: String,
    unique: true
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
    enum: ['Pending', 'Approved', 'Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Reported'],
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
    const count = await mongoose.model('RadiologyRequest').countDocuments();
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
radiologyRequestSchema.index({ patientId: 1, requestedDate: -1 });
radiologyRequestSchema.index({ doctorId: 1, status: 1 });
radiologyRequestSchema.index({ status: 1, scheduledDate: 1 });
radiologyRequestSchema.index({ requestNumber: 1 });
radiologyRequestSchema.index({ admissionId: 1, sourceType: 'IPD' });

module.exports = mongoose.model('RadiologyRequest', radiologyRequestSchema);