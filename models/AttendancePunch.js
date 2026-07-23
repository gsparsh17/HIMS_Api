const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'BiometricDevice', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', index: true },
  deviceUserCode: { type: String, required: true },
  timestamp: { type: Date, required: true, index: true },
  direction: { type: String, enum: ['in', 'out', 'unknown'], default: 'unknown' },
  source: { type: String, enum: ['biometric', 'device_import', 'manual_import'], default: 'biometric' },
  rawEventId: { type: String, required: true },
  receivedAt: { type: Date, default: Date.now },
  validationStatus: { type: String, enum: ['pending', 'valid', 'unmapped', 'duplicate', 'invalid', 'reconciled', 'exception'], default: 'pending', index: true },
  validationMessage: String,
  raw: mongoose.Schema.Types.Mixed,
  reconciledAttendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffAttendance' }
}, { timestamps: false, versionKey: false });
schema.index({ deviceId: 1, rawEventId: 1 }, { unique: true });
schema.index({ hospitalId: 1, employeeId: 1, timestamp: 1 });
module.exports = mongoose.model('AttendancePunch', schema);
