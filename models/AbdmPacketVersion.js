const mongoose = require('mongoose');

const encryptedJsonSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, select: false },
    iv: { type: String, select: false },
    tag: { type: String, select: false },
    keyVersion: { type: String, default: 'v1', select: false }
  },
  { _id: false }
);

const sourceItemSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revision: String,
    updatedAt: Date,
    sourceHash: { type: String, required: true },
    included: { type: Boolean, default: true },
    reason: String
  },
  { _id: false }
);

const approvalSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: String,
    approvedAt: { type: Date, default: Date.now },
    bundleHash: { type: String, required: true },
    note: String
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    packetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AbdmPacket',
      required: true,
      index: true
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true
    },
    careContextId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AbdmCareContext',
      required: true,
      index: true
    },
    careContextReference: { type: String, required: true, index: true },
    hiType: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    status: {
      type: String,
      enum: [
        'PREPARED',
        'VALIDATED',
        'VALIDATION_FAILED',
        'APPROVED',
        'SUPERSEDED',
        'TRANSFERRED'
      ],
      default: 'PREPARED',
      index: true
    },
    fhirPackage: { type: String, required: true },
    fhirVersion: { type: String, required: true },
    expectedProfile: { type: String, required: true },
    bundleHash: { type: String, required: true, index: true },
    sourceSnapshotHash: { type: String, required: true, index: true },
    sourceManifest: [sourceItemSchema],
    encryptedBundle: { type: encryptedJsonSchema, select: false, required: true },
    bundleSizeBytes: Number,
    validation: {
      valid: Boolean,
      validator: String,
      package: String,
      fhirVersion: String,
      validatedBundleHash: String,
      errors: [mongoose.Schema.Types.Mixed],
      warnings: [mongoose.Schema.Types.Mixed],
      validatedAt: Date
    },
    consentBinding: {
      consentId: String,
      consentScopeHash: { type: String, index: true },
      hiuId: String,
      purpose: mongoose.Schema.Types.Mixed,
      dateRange: { from: Date, to: Date },
      expiresAt: Date
    },
    approvals: [approvalSchema],
    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    supersedesVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmPacketVersion' },
    transferredAt: Date,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ packetId: 1, version: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });
schema.index({ hospitalId: 1, careContextId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmPacketVersion', schema);
