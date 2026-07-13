const mongoose = require('mongoose');

const abdmConsentSchema = new mongoose.Schema(
  {
    consentId: { type: String, required: true, unique: true, index: true },
    facilityId: { type: String, required: true, index: true },
    patientReference: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: {
      type: String,
      enum: ['REQUESTED', 'GRANTED', 'DENIED', 'REVOKED', 'EXPIRED'],
      required: true,
      index: true
    },
    hiTypes: [String],
    purpose: mongoose.Schema.Types.Mixed,
    dateRange: {
      from: Date,
      to: Date
    },
    careContextReferences: [String],
    permission: mongoose.Schema.Types.Mixed,
    rawReference: mongoose.Schema.Types.Mixed,
    expiresAt: Date
  },
  { timestamps: true }
);

module.exports = mongoose.model('AbdmConsent', abdmConsentSchema);
