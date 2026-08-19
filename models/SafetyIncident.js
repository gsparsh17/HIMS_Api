'use strict';
const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  incidentNumber: { type: String, required: true },
  incidentType: { type: String, enum: ['infection','patient_safety','sentinel_event','staff_exposure','transfusion','medication_error','medication_near_miss','adverse_drug_reaction'], required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  category: { type: String, required: true, trim: true },
  severity: { type: String, enum: ['low','moderate','high','critical'], default: 'moderate' },
  status: { type: String, enum: ['open','under_review','capa_in_progress','closed'], default: 'open', index: true },
  occurredAt: { type: Date, default: operationNow },
  details: { type: mongoose.Schema.Types.Mixed, required: true },
  correctiveActions: [{ action: String, owner: String, dueAt: Date, completedAt: Date, status: { type: String, enum: ['open','completed'], default: 'open' } }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, incidentNumber: 1 }, { unique: true });
module.exports = mongoose.model('SafetyIncident', schema);
