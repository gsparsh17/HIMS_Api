const mongoose = require('mongoose');

const dischargeSummarySchema = new mongoose.Schema({
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission',
    required: true,
    index: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true
  },
  preparedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },
  admissionDate: {
    type: Date,
    required: true
  },
  dischargeDate: {
    type: Date,
    required: true
  },
  finalDiagnosis: {
    type: String,
    trim: true
  },
  chiefComplaints: {
    type: String,
    trim: true
  },
  historyOfPresentIllness: {
    type: String,
    trim: true
  },
  pastMedicalHistory: {
    type: String,
    trim: true
  },
  examinationFindings: {
    type: String,
    trim: true
  },
  investigations: {
    type: String,
    trim: true
  },
  treatmentGiven: {
    type: String,
    trim: true
  },
  proceduresDone: {
    type: String,
    trim: true
  },
  surgeriesDone: {
    type: String,
    trim: true
  },
  conditionOnDischarge: {
    type: String,
    enum: ['Recovered', 'Improved', 'Stabilized', 'Referred', 'Expired', 'LAMA', 'Unchanged'],
    default: 'Improved'
  },
  dischargeMedications: [{
    medicineName: String,
    dosage: String,
    frequency: String,
    duration: String,
    instructions: String
  }],
  followUpAdvice: {
    type: String,
    trim: true
  },
  followUpDate: {
    type: Date
  },
  emergencyInstructions: {
    type: String,
    trim: true
  },
  dietAdvice: {
    type: String,
    trim: true
  },
  activityAdvice: {
    type: String,
    trim: true
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor'
  },
  reviewedAt: {
    type: Date
  },
  status: {
    type: String,
    enum: ['Draft', 'Pending Review', 'Finalized', 'StaffCompleted'],
    default: 'Draft'
  },
  finalizedAt: {
    type: Date
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
dischargeSummarySchema.index({ admissionId: 1 });
dischargeSummarySchema.index({ patientId: 1, dischargeDate: -1 });
dischargeSummarySchema.index({ status: 1, preparedBy: 1 });
dischargeSummarySchema.index({ 'abdmRecordLink.abhaNumber': 1 });
dischargeSummarySchema.index({ 'abdmRecordLink.abhaAddress': 1 });

module.exports = mongoose.model('DischargeSummary', dischargeSummarySchema);