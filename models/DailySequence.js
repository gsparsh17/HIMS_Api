const mongoose = require('mongoose');

const dailySequenceSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  key: {
    type: String,
    required: true,
    trim: true
  },
  value: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, { timestamps: true });

dailySequenceSchema.index({ hospitalId: 1, key: 1 }, { unique: true });

module.exports = mongoose.models.DailySequence
  || mongoose.model('DailySequence', dailySequenceSchema);
