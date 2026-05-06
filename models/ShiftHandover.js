const mongoose = require('mongoose');

const isbarSchema = new mongoose.Schema({
  // I - Identify
  identify: {
    patientName: { type: String, required: true },
    patientId: { type: String },
    age: { type: String },
    gender: { type: String },
    bedNumber: { type: String },
    admissionDate: { type: Date },
    primaryDoctor: { type: String },
    allergies: { type: String, default: '' }
  },
  // S - Situation
  situation: {
    reasonForAdmission: { type: String, default: '' },
    currentCondition: {
      type: String,
      enum: ['Stable', 'Improving', 'Critical', 'Deteriorating'],
      default: 'Stable'
    },
    primaryDiagnosis: { type: String, default: '' },
    recentChanges: { type: String, default: '' }
  },
  // B - Background
  background: {
    medicalHistory: { type: String, default: '' },
    currentMedications: { type: String, default: '' },
    recentProcedures: { type: String, default: '' },
    relevantLabResults: { type: String, default: '' }
  },
  // A - Assessment
  assessment: {
    latestVitals: { type: String, default: '' },
    painScore: { type: Number, default: 0 },
    consciousnessLevel: { type: String, default: 'Alert' },
    nursingAssessment: { type: String, default: '' },
    ivLines: { type: String, default: '' },
    drains: { type: String, default: '' },
    inputOutput: { type: String, default: '' }
  },
  // R - Recommendation
  recommendation: {
    pendingTasks: { type: String, default: '' },
    pendingInvestigations: { type: String, default: '' },
    medicationsDue: { type: String, default: '' },
    specialInstructions: { type: String, default: '' },
    escalationPlan: { type: String, default: '' }
  }
});

const shiftHandoverSchema = new mongoose.Schema({
  // Shift info
  handoverDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  outgoingShift: {
    type: String,
    enum: ['Morning', 'Evening', 'Night'],
    required: true
  },
  incomingShift: {
    type: String,
    enum: ['Morning', 'Evening', 'Night'],
    required: true
  },
  // Nurse assignments
  outgoingNurse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff',
    required: true
  },
  incomingNurse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff'
  },
  autoAssigned: {
    type: Boolean,
    default: false
  },
  // Patient ISBAR records
  patients: [{
    admissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'IPDAdmission',
      required: true
    },
    isbar: isbarSchema
  }],
  // General handover notes
  generalNotes: { type: String, default: '' },
  wardCondition: { type: String, default: '' },
  equipmentIssues: { type: String, default: '' },
  // Status
  status: {
    type: String,
    enum: ['Draft', 'Submitted', 'Acknowledged'],
    default: 'Draft'
  },
  acknowledgedAt: { type: Date },
  acknowledgedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Staff'
  }
}, {
  timestamps: true
});

// Index for efficient queries
shiftHandoverSchema.index({ outgoingNurse: 1, handoverDate: -1 });
shiftHandoverSchema.index({ incomingNurse: 1, status: 1 });
shiftHandoverSchema.index({ handoverDate: 1, outgoingShift: 1 });

module.exports = mongoose.model('ShiftHandover', shiftHandoverSchema);
