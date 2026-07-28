const mongoose = require('mongoose');

const abdmLinkAuthenticationSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    linkRefNumber: { type: String, required: true, index: true },
    transactionId: { type: String, index: true },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true
    },
    patientReference: { type: String, index: true },
    careContextReferences: [{ type: String }],
    otpHash: { type: String, required: true, select: false },
    otpSalt: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    status: {
      type: String,
      enum: ['PENDING', 'VERIFIED', 'EXPIRED', 'LOCKED', 'FAILED'],
      default: 'PENDING',
      index: true
    },
    verifiedAt: Date,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

abdmLinkAuthenticationSchema.index(
  { hospitalId: 1, linkRefNumber: 1 },
  { unique: true }
);
abdmLinkAuthenticationSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60 }
);

module.exports = mongoose.model(
  'AbdmLinkAuthentication',
  abdmLinkAuthenticationSchema
);
