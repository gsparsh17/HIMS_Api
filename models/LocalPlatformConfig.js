const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  singletonKey: { type: String, default: 'platform', unique: true }, masterUrl: String, tenantCode: String, connectorKeyId: String,
  connectorSecretEncrypted: { ciphertext: String, iv: String, tag: String }, installationId: String, enrollmentId: String, masterConfirmedAt: Date, enrolledAt: Date
}, { timestamps: true });
module.exports = mongoose.model('LocalPlatformConfig', schema);
