const mongoose = require('mongoose');

const abdmCounterSequenceSchema = new mongoose.Schema(
  {
    counterId: { type: String, required: true },
    dateKey: { type: String, required: true },
    sequence: { type: Number, default: 0 }
  },
  { timestamps: true }
);

abdmCounterSequenceSchema.index({ counterId: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('AbdmCounterSequence', abdmCounterSequenceSchema);
