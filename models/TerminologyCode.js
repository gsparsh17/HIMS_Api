'use strict';

const mongoose = require('mongoose');

const terminologyCodeSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    default: null,
    index: true
  },
  system: {
    type: String,
    enum: ['ICD-10', 'ICD-11', 'SNOMED_CT', 'LOINC', 'NRCeS', 'LOCAL'],
    required: true,
    index: true
  },
  version: { type: String, default: '', trim: true },
  code: { type: String, required: true, trim: true, index: true },
  display: { type: String, required: true, trim: true, index: true },
  synonyms: { type: [String], default: [] },
  category: { type: String, trim: true },
  active: { type: Boolean, default: true, index: true },
  sourceUri: { type: String, trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

terminologyCodeSchema.index(
  { hospitalId: 1, system: 1, version: 1, code: 1 },
  { unique: true }
);

module.exports = mongoose.model('TerminologyCode', terminologyCodeSchema);
