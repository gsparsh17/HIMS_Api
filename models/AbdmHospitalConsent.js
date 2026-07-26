const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    role: { type: String, enum: ['HIP', 'HIU'], required: true, index: true },
    consentRequestId: { type: String, index: true },
    consentId: { type: String, index: true },
    artefactId: { type: String, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaAddress: { type: String, lowercase: true, trim: true, index: true },
    status: {
      type: String,
      enum: [
        'DRAFT',
        'REQUESTED',
        'PENDING',
        'GRANTED',
        'DENIED',
        'REVOKED',
        'EXPIRED',
        'FAILED'
      ],
      default: 'DRAFT',
      index: true
    },
    purpose: mongoose.Schema.Types.Mixed,
    hiTypes: [String],
    dateRange: { from: Date, to: Date },
    permission: mongoose.Schema.Types.Mixed,
    careContextReferences: [String],
    hipIds: [String],
    hiuId: String,
    requester: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      identifier: String
    },
    encryptedArtefact: {
      ciphertext: { type: String, select: false },
      iv: { type: String, select: false },
      tag: { type: String, select: false },
      keyVersion: { type: String, default: 'v1', select: false }
    },
    artefactHash: String,
    signatureValidated: { type: Boolean, default: false },
    grantedAt: Date,
    expiresAt: Date,
    revokedAt: Date,
    lastStatusCheckedAt: Date,
    lastCallbackAt: Date,
    metadata: mongoose.Schema.Types.Mixed,
    error: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index(
  { hospitalId: 1, role: 1, consentId: 1 },
  {
    unique: true,
    partialFilterExpression: { consentId: { $type: 'string' } }
  }
);
schema.index(
  { hospitalId: 1, role: 1, consentRequestId: 1 },
  {
    unique: true,
    partialFilterExpression: { consentRequestId: { $type: 'string' } }
  }
);
schema.index({ hospitalId: 1, patientId: 1, role: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmHospitalConsent', schema);
