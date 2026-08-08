'use strict';
const mongoose = require('mongoose');
const itemSchema = new mongoose.Schema({
  orderType: { type: String, enum: ['medication', 'laboratory', 'radiology', 'procedure'], required: true },
  masterId: { type: mongoose.Schema.Types.ObjectId, required: true },
  code: { type: String, trim: true },
  name: { type: String, required: true, trim: true },
  priority: { type: String, enum: ['routine', 'urgent', 'stat'], default: 'routine' },
  defaults: mongoose.Schema.Types.Mixed
}, { _id: true, minimize: false });
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  name: { type: String, required: true, trim: true },
  diagnosisCodes: [{ type: String, trim: true, uppercase: true }],
  items: { type: [itemSchema], default: [] },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });
schema.index({ hospitalId: 1, name: 1 }, { unique: true });
module.exports = mongoose.model('ClinicalOrderSet', schema);
