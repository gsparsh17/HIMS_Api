const mongoose = require('mongoose');

const platformProvisioningReceiptSchema = new mongoose.Schema({
  provisioningId: { type: String, required: true, unique: true, index: true },
  version: { type: Number, required: true, default: 1 },
  tenantCode: { type: String, required: true, uppercase: true, trim: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  masterHospitalId: String,
  completedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('PlatformProvisioningReceipt', platformProvisioningReceiptSchema);
