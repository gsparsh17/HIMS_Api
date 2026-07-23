const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiometricDevice', required: true, index: true },
  deviceUserCode: { type: String, required: true, trim: true },
  identifierType: { type: String, enum: ['user_code', 'card', 'fingerprint', 'face', 'other'], default: 'user_code' },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true, index: true },
  active: { type: Boolean, default: true },
  mappedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  mappedAt: { type: Date, default: Date.now }
}, { timestamps: true });
schema.index({ hospitalId: 1, deviceId: 1, deviceUserCode: 1 }, { unique: true });
module.exports = mongoose.model('BiometricEmployeeMap', schema);
