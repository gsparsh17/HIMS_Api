const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  code: { type: String, required: true, trim: true },
  label: { type: String, required: true },
  module: { type: String, required: true, index: true },
  description: String,
  formula: String,
  sourceModels: [String],
  dimensions: [String],
  defaultGrain: { type: String, default: 'day' },
  refreshCadence: { type: String, default: 'live' },
  permissionKey: String,
  isActive: { type: Boolean, default: true },
  version: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, code: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model('MISMetricDefinition', schema);
