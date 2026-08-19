'use strict';
const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  requestNumber: { type: String, required: true, trim: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  bloodGroup: { type: String, required: true },
  component: { type: String, required: true },
  unitsRequested: { type: Number, required: true, min: 1 },
  priority: { type: String, enum: ['routine','urgent','emergency'], default: 'routine' },
  status: { type: String, enum: ['requested','reserved','shortage','dispatched','cancelled'], default: 'requested', index: true },
  reservedUnitIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'BloodUnit' }],
  shortageReason: String,
  delayReason: String,
  timeline: [{ activity: { type: String, required: true }, at: { type: Date, default: operationNow }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String }],
  requestedAt: { type: Date, default: operationNow },
  dispatchedAt: Date,
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, requestNumber: 1 }, { unique: true });
module.exports = mongoose.model('BloodComponentRequest', schema);
