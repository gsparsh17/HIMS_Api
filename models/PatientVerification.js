'use strict';

const mongoose = require('mongoose');

const patientVerificationSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  purpose: {
    type: String,
    enum: ['patient_mobile', 'patient_identity'],
    default: 'patient_mobile'
  },
  phone: { type: String, required: true, index: true },
  otpHash: { type: String, required: true, select: false },
  status: {
    type: String,
    enum: ['pending', 'verified', 'consumed', 'expired', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  expiresAt: { type: Date, required: true, index: true },
  verifiedAt: Date,
  consumedAt: Date,
  notificationDeliveryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'NotificationDelivery'
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

patientVerificationSchema.index({ hospitalId: 1, phone: 1, createdAt: -1 });
patientVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('PatientVerification', patientVerificationSchema);
