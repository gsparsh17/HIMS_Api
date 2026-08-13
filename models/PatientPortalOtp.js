const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  mobile: { type: String, required: true, index: true },
  purpose: { type: String, enum: ['LOGIN'], default: 'LOGIN' },
  otpHash: { type: String, required: true, select: false },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  expiresAt: { type: Date, required: true, index: true },
  verifiedAt: Date,
  requestContext: {
    ipHash: String,
    userAgentHash: String
  }
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ hospitalId: 1, mobile: 1, createdAt: -1 });
module.exports = mongoose.model('PatientPortalOtp', schema);
