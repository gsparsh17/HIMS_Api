const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  vendor: String,
  model: String,
  serialNumber: String,
  location: String,
  timezone: { type: String, default: 'Asia/Kolkata' },
  status: { type: String, enum: ['active', 'inactive', 'maintenance', 'revoked'], default: 'active' },
  auth: { keyId: String, secretHash: String, certificateFingerprint: String },
  lastSyncAt: Date,
  lastEventAt: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
schema.index({ hospitalId: 1, code: 1 }, { unique: true });
schema.index({ hospitalId: 1, serialNumber: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model('BiometricDevice', schema);
