const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  grantId: { type: String, required: true, unique: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  purpose: { type: String, enum: ['EMERGENCY_LOCAL'], default: 'EMERGENCY_LOCAL' },
  reason: { type: String, required: true, trim: true, maxlength: 2000 },
  scope: [{ type: String, enum: ['clinical_read'] }],
  issuedAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewStatus: { type: String, enum: ['PENDING_REVIEW', 'REVIEWED_OK', 'REVIEWED_CONCERN'], default: 'PENDING_REVIEW', index: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewNote: { type: String, trim: true, maxlength: 2000 },
  deviceContext: {
    sourceIpHash: String,
    userAgentHash: String,
    requestId: String
  }
}, { timestamps: true });

schema.index({ hospitalId: 1, userId: 1, patientId: 1, expiresAt: 1 });
schema.index({ hospitalId: 1, reviewStatus: 1, issuedAt: -1 });
module.exports = mongoose.model('BreakGlassGrant', schema);
