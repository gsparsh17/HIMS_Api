'use strict';
const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  donorNumber: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  dateOfBirth: { type: Date, required: true },
  phone: String,
  bloodGroup: { type: String, required: true, enum: ['A+','A-','B+','B-','AB+','AB-','O+','O-'] },
  screening: {
    consent: { type: Boolean, required: true },
    hemoglobinOk: { type: Boolean, default: true },
    infectionScreenNegative: { type: Boolean, default: true },
    medicallyFit: { type: Boolean, default: true },
    notes: String,
    screenedAt: { type: Date, default: operationNow },
    screenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  eligibilityStatus: { type: String, enum: ['eligible','deferred'], required: true, index: true },
  deferralReason: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, donorNumber: 1 }, { unique: true });
module.exports = mongoose.model('BloodDonor', schema);
