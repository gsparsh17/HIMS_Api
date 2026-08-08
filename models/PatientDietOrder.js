'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  dietType: { type: String, required: true, trim: true },
  instructions: { type: String, trim: true },
  allergiesConsidered: { type: Boolean, default: false },
  startsAt: { type: Date, default: Date.now },
  endsAt: Date,
  status: { type: String, enum: ['active', 'completed', 'cancelled'], default: 'active', index: true },
  orderedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, patientId: 1, startsAt: -1 });
module.exports = mongoose.model('PatientDietOrder', schema);
