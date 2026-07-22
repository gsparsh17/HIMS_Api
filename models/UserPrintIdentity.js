const mongoose = require('mongoose');

const userPrintIdentitySchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  printedName: { type: String, trim: true },
  designation: { type: String, trim: true },
  department: { type: String, trim: true },
  qualification: { type: String, trim: true },
  registrationNumber: { type: String, trim: true },
  registrationCouncil: { type: String, trim: true },
  defaultSignatureAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrintIdentityAsset' },
  defaultSealAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrintIdentityAsset' },
  verificationStatus: {
    type: String,
    enum: ['unverified', 'pending', 'verified', 'rejected', 'suspended'],
    default: 'unverified',
    index: true
  },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  rejectionReason: { type: String, trim: true },
  isActive: { type: Boolean, default: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

userPrintIdentitySchema.index({ hospitalId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('UserPrintIdentity', userPrintIdentitySchema);
