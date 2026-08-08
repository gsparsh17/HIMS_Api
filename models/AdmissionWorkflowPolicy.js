'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionType: { type: String, required: true, trim: true, lowercase: true },
  version: { type: Number, default: 1, min: 1 },
  requiredDocuments: [{ type: String, trim: true }],
  requiredSteps: [{ key: { type: String, required: true, trim: true }, label: { type: String, required: true, trim: true }, required: { type: Boolean, default: true } }],
  active: { type: Boolean, default: true, index: true },
  effectiveFrom: { type: Date, default: Date.now },
  effectiveTo: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, admissionType: 1, version: 1 }, { unique: true });
module.exports = mongoose.model('AdmissionWorkflowPolicy', schema);
