'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  issueNumber: { type: String, required: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
  itemDescription: { type: String, required: true },
  issueDetails: { type: String, required: true },
  severity: { type: String, enum: ['low','moderate','high','critical'], default: 'moderate' },
  status: { type: String, enum: ['open','supplier_notified','capa_in_progress','closed'], default: 'open', index: true },
  correctiveAction: String,
  closedAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, issueNumber: 1 }, { unique: true });
module.exports = mongoose.model('SupplierQualityIssue', schema);
