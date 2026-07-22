const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reportKey: { type: String, required: true },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  format: { type: String, enum: ['csv', 'xlsx', 'pdf'], required: true },
  status: { type: String, enum: ['Queued', 'Processing', 'Completed', 'Failed', 'Expired'], default: 'Queued', index: true },
  filename: String,
  mimeType: String,
  output: Buffer,
  checksum: String,
  rowCount: Number,
  error: String,
  requestedAt: { type: Date, default: Date.now },
  completedAt: Date,
  expiresAt: { type: Date, index: true }
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('MISExportJob', schema);
