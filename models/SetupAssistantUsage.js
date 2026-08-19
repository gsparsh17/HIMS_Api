const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  dateKey: { type: String, required: true, index: true },
  count: { type: Number, default: 0, min: 0 },
  lastUsedAt: Date,
  // Daily quota rows are operational counters, not permanent audit records.
  // Keep a short history and let MongoDB prune old counters automatically.
  expiresAt: { type: Date, default: () => new Date(Date.now() + 45 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

schema.index({ hospitalId: 1, userId: 1, dateKey: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SetupAssistantUsage', schema);
