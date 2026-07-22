const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  reportKey: { type: String, required: true, index: true },
  grain: { type: String, default: 'day' },
  periodStart: { type: Date, required: true, index: true },
  periodEnd: { type: Date, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  sourceChecksum: String,
  generatedAt: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['Fresh', 'Stale', 'Failed'], default: 'Fresh' },
  errors: [String]
}, { timestamps: true });
schema.index({ hospitalId: 1, reportKey: 1, grain: 1, periodStart: 1 }, { unique: true });
module.exports = mongoose.model('MISSnapshot', schema);
