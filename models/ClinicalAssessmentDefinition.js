'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  definitionType: { type: String, enum: ['icu_criteria', 'mortality_scale', 'functional_scale'], required: true, index: true },
  name: { type: String, required: true, trim: true },
  version: { type: String, required: true, trim: true, default: '1' },
  sourceReference: { type: String, required: true, trim: true },
  definition: { type: mongoose.Schema.Types.Mixed, required: true },
  governanceStatus: { type: String, enum: ['draft', 'approved', 'retired'], default: 'draft', index: true },
  validatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  validatedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  effectiveFrom: Date,
  effectiveTo: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, definitionType: 1, name: 1, version: 1 }, { unique: true });
module.exports = mongoose.model('ClinicalAssessmentDefinition', schema);
