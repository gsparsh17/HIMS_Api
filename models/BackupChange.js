const mongoose = require('mongoose');

const backupChangeSchema = new mongoose.Schema({
  collectionName: { type: String, required: true, index: true },
  operationType: { type: String, enum: ['insert', 'update', 'replace', 'delete'], required: true },
  documentKey: { type: mongoose.Schema.Types.Mixed, required: true },
  clusterTime: { type: mongoose.Schema.Types.Mixed },
  resumeToken: { type: mongoose.Schema.Types.Mixed },
  capturedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true, minimize: false });

backupChangeSchema.index({ _id: 1, collectionName: 1 });

module.exports = mongoose.model('BackupChange', backupChangeSchema);
