'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  assessmentType: { type: String, enum: ['icu_eligibility', 'mortality_score', 'rehabilitation'], required: true, index: true },
  definitionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicalAssessmentDefinition' },
  definitionVersion: String,
  observations: mongoose.Schema.Types.Mixed,
  score: Number,
  riskBand: String,
  eligible: Boolean,
  result: mongoose.Schema.Types.Mixed,
  treatmentPlan: mongoose.Schema.Types.Mixed,
  assessedAt: { type: Date, default: Date.now, index: true },
  assessedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  supersedesId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicalAssessmentRecord' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, patientId: 1, assessmentType: 1, assessedAt: -1 });
module.exports = mongoose.model('ClinicalAssessmentRecord', schema);
