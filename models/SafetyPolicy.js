'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  policyType: { type: String, enum: ['antimicrobial_usage'], required: true, index: true },
  name: { type: String, required: true, trim: true },
  version: { type: String, required: true, trim: true },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  active: { type: Boolean, default: true, index: true },
  effectiveFrom: { type: Date, default: Date.now },
  effectiveTo: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, policyType: 1, name: 1, version: 1 }, { unique: true });
module.exports = mongoose.model('SafetyPolicy', schema);
