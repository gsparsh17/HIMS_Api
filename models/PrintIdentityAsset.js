const mongoose = require('mongoose');

const printIdentityAssetSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  identityId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserPrintIdentity', required: true, index: true },
  assetType: { type: String, enum: ['signature', 'seal', 'initials'], required: true, index: true },
  label: { type: String, trim: true },
  version: { type: Number, required: true, min: 1 },
  storagePath: { type: String, required: true },
  originalName: { type: String, trim: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, default: 0 },
  width: Number,
  height: Number,
  sha256: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'verified', 'rejected', 'retired'], default: 'pending', index: true },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  rejectionReason: { type: String, trim: true },
  retiredAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

printIdentityAssetSchema.index({ hospitalId: 1, userId: 1, assetType: 1, version: -1 });
printIdentityAssetSchema.index({ identityId: 1, assetType: 1, status: 1 });

module.exports = mongoose.model('PrintIdentityAsset', printIdentityAssetSchema);
