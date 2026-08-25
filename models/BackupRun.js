const mongoose = require('mongoose');

const backupRunSchema = new mongoose.Schema({
  backupId: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['full', 'incremental'], required: true, index: true },
  status: { type: String, enum: ['running', 'success', 'partial', 'failed', 'skipped'], default: 'running', index: true },
  fileName: String,
  localPath: String,
  baseFullBackupId: String,
  startedAt: { type: Date, default: Date.now },
  completedAt: Date,
  checkpointEventId: mongoose.Schema.Types.ObjectId,
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  targets: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: String
}, { timestamps: true, minimize: false });

backupRunSchema.index({ type: 1, completedAt: -1 });

module.exports = mongoose.model('BackupRun', backupRunSchema);
