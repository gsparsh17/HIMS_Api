const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  preOpDiagnosis: String,
  plannedProcedure: String,
  plannedAnaesthesia: { type: String, enum: ['General', 'Spinal', 'Epidural', 'Regional', 'Local', 'Sedation', 'Combined', 'Other', ''], default: '' },
  electiveEmergency: { type: String, enum: ['Elective', 'Emergency', 'Urgent', ''], default: '' },
  history: { medical: String, surgical: String, anaesthesia: String, addictions: String, currentMedications: String, allergies: String },
  examination: {
    heartRate: Number, bloodPressure: String, respiratoryRate: Number, spo2: Number, temperature: Number,
    airway: String, mouthOpening: String, mallampati: String, dentition: String, neckMovement: String,
    cvs: String, respiratory: String, cns: String, abdomen: String
  },
  investigations: [{ name: String, result: String, date: Date, acceptable: Boolean }],
  asaClass: { type: String, enum: ['I', 'II', 'III', 'IV', 'V', 'VI', ''], default: '' },
  riskSummary: String,
  optimizationRequired: Boolean,
  optimizationPlan: String,
  fitnessStatus: { type: String, enum: ['Pending', 'Fit', 'Fit With Risk', 'Temporarily Unfit', 'Unfit'], default: 'Pending' },
  npoInstructions: String,
  premedicationPlan: String,
  bloodRequirement: String,
  status: { type: String, enum: ['Draft', 'Completed', 'Signed', 'Amended'], default: 'Draft', index: true },
  assessedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assessedAt: Date,
  signedAt: Date,
  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('OTPreAnaesthesiaAssessment', schema);
