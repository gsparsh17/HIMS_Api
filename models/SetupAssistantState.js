const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  skippedSteps: { type: [String], default: [] },
  lastViewedAt: Date,
}, { timestamps: true });

schema.index({ hospitalId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('SetupAssistantState', schema);
