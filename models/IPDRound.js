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
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
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