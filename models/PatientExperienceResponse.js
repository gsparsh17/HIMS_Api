'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  referenceNumber: { type: String, required: true },
  responseType: { type: String, enum: ['feedback','complaint','prom','prem'], required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  surveyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientExperienceSurvey' },
  locale: { type: String, default: 'en' },
  responses: mongoose.Schema.Types.Mixed,
  score: Number,
  category: String,
  comments: String,
  status: { type: String, enum: ['submitted','open','in_progress','resolved'], default: 'submitted', index: true },
  resolution: { note: String, resolvedAt: Date, resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
  source: { type: String, enum: ['portal','sms','email','messaging','staff'], default: 'portal' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, referenceNumber: 1 }, { unique: true });
module.exports = mongoose.model('PatientExperienceResponse', schema);
