'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  title: { type: Map, of: String, required: true },
  message: { type: Map, of: String, required: true },
  audience: { type: String, enum: ['all','opd','ipd','emergency'], default: 'all' },
  active: { type: Boolean, default: true, index: true },
  startsAt: { type: Date, default: Date.now },
  endsAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
module.exports = mongoose.model('PatientAnnouncement', schema);
