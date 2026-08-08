'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  unitNumber: { type: String, required: true, trim: true },
  donorId: { type: mongoose.Schema.Types.ObjectId, ref: 'BloodDonor' },
  bloodGroup: { type: String, required: true, enum: ['A+','A-','B+','B-','AB+','AB-','O+','O-'], index: true },
  component: { type: String, required: true, enum: ['whole_blood','packed_rbc','platelets','plasma','cryoprecipitate'], index: true },
  collectedAt: { type: Date, default: Date.now },
  expiresAt: Date,
  storageLocation: String,
  volumeMl: Number,
  status: { type: String, enum: ['available','reserved','dispatched','transfused','discarded','expired'], default: 'available', index: true },
  reservedForRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'BloodComponentRequest' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, unitNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, bloodGroup: 1, component: 1, status: 1, expiresAt: 1 });
module.exports = mongoose.model('BloodUnit', schema);
