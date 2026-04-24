const mongoose = require('mongoose');

const ipdRoundSchema = new mongoose.Schema({
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
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },
  roundDateTime: {
    type: Date,
    default: Date.now
  },
  patientCondition: {
    type: String,
    enum: ['Stable', 'Improving', 'Critical', 'Deteriorating', 'Serious', 'Recovering'],
    default: 'Stable'
  },
  complaints: {
    type: String,
    trim: true
  },
  symptoms: {
    type: String,
    trim: true
  },
  examinationFindings: {
    type: String,
    trim: true
  },
  diagnosis: {
    type: String,
    trim: true
  },
  treatmentPlan: {
    type: String,
    trim: true
  },
  advice: {
    type: String,
    trim: true
  },
  medicationsPrescribed: [{
    medicineName: String,
    dosage: String,
    frequency: String,
    duration: String
  }],
  investigationsOrdered: [{
    testName: String,
    urgency: { type: String, enum: ['Routine', 'Urgent', 'Stat'], default: 'Routine' }
  }],
  proceduresOrdered: [{
    procedureName: String,
    urgency: { type: String, enum: ['Routine', 'Urgent', 'Emergency'], default: 'Routine' }
  }],
  dischargeSuggested: {
    type: Boolean,
    default: false
  },
  nextReviewDate: {
    type: Date
  },
  notes: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
ipdRoundSchema.index({ admissionId: 1, roundDateTime: -1 });
ipdRoundSchema.index({ doctorId: 1, roundDateTime: -1 });

module.exports = mongoose.model('IPDRound', ipdRoundSchema);