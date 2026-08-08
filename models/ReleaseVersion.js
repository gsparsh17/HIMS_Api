'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  version: { type: String, required: true, trim: true },
  releaseType: { type: String, enum: ['source_revision','patch','security_update','feature_release'], required: true, index: true },
  commitReference: { type: String, trim: true },
  issueReferences: [{ type: String, trim: true }],
  summary: { type: String, required: true, trim: true },
  documentationUrl: String,
  releasedAt: { type: Date, default: Date.now, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, version: 1, releaseType: 1 }, { unique: true });
module.exports = mongoose.model('ReleaseVersion', schema);
