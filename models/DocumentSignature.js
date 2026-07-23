const mongoose = require('mongoose');

const placementSchema = new mongoose.Schema({
  assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrintIdentityAsset', required: true },
  assetType: { type: String, enum: ['signature', 'seal', 'initials'], required: true },
  page: { type: Number, default: 1, min: 1 },
  x: { type: Number, required: true, min: 0, max: 1 },
  y: { type: Number, required: true, min: 0, max: 1 },
  width: { type: Number, required: true, min: 0.01, max: 1 },
  height: { type: Number, required: true, min: 0.01, max: 1 },
  rotation: { type: Number, default: 0 },
  locked: { type: Boolean, default: false }
}, { _id: false });

const assetSnapshotSchema = new mongoose.Schema({
  assetId: mongoose.Schema.Types.ObjectId,
  assetType: String,
  version: Number,
  sha256: String,
  storagePath: String,
  cloudinaryUrl: String,
  mimeType: String,
  originalName: String
}, { _id: false });

const documentSignatureSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  encounterDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'EncounterDocument', index: true },
  documentType: { type: String, required: true, index: true },
  sourceModel: { type: String, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sourceRevision: { type: Number, default: 1 },
  templateId: { type: String, trim: true },
  templateVersion: { type: String, trim: true },
  signerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  signerName: { type: String, required: true, trim: true },
  signerRole: { type: String, trim: true },
  signatoryRole: { type: String, trim: true, index: true },
  signerDesignation: { type: String, trim: true },
  signerRegistrationNumber: { type: String, trim: true },
  assetSnapshots: [assetSnapshotSchema],
  placements: [placementSchema],
  sourceHash: { type: String, required: true },
  signatureHash: { type: String, required: true, unique: true, index: true },
  verificationCode: { type: String, required: true, unique: true, index: true },
  signedAt: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['signed', 'superseded', 'revoked'], default: 'signed', index: true },
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentSignature' },
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokeReason: { type: String, trim: true },
  metadata: mongoose.Schema.Types.Mixed
}, { timestamps: true });

documentSignatureSchema.index({ hospitalId: 1, sourceModel: 1, sourceId: 1, signatoryRole: 1, signedAt: -1 });

module.exports = mongoose.model('DocumentSignature', documentSignatureSchema);
