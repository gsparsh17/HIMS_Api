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
    enum: ['Draft', 'Pending Review', 'Finalized'],
    default: 'Draft'
  },
  finalizedAt: {
    type: Date
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

module.exports = mongoose.model('DischargeSummary', dischargeSummarySchema);