const mongoose = require('mongoose');

const patientIdentityAssetSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  assetType: { type: String, enum: ['patient_signature', 'thumb_impression'], required: true, index: true },
  captureMethod: { type: String, enum: ['drawn', 'typed_acknowledgement', 'uploaded', 'biometric'], required: true },
  label: { type: String, trim: true },
  version: { type: Number, required: true, min: 1 },
  storagePath: { type: String, required: true },
  externalUrl: { type: String, trim: true },
  originalName: { type: String, trim: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, default: 0 },
  sha256: { type: String, required: true, index: true },
  capturedName: { type: String, trim: true },
  acknowledgementText: { type: String, trim: true },
  typedFontFamily: { type: String, trim: true },
  legalLabel: { type: String, trim: true, default: 'Patient identity mark' },
  evidence: {
    capturedAt: Date,
    ipAddress: String,
    userAgent: String,
    admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
    consentId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDConsent' },
    witnessName: String
  },
  biometricDevice: { type: String, trim: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
  isDefault: { type: Boolean, default: false, index: true },
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokeReason: { type: String, trim: true }
}, { timestamps: true });

patientIdentityAssetSchema.index({ hospitalId: 1, patientId: 1, assetType: 1, version: 1 }, { unique: true });
patientIdentityAssetSchema.index({ hospitalId: 1, patientId: 1, assetType: 1, isDefault: 1, status: 1 });

module.exports = mongoose.model('PatientIdentityAsset', patientIdentityAssetSchema);
