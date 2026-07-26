const mongoose = require('mongoose');

const abdmCounterSequenceSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    counterId: { type: String, required: true },
    dateKey: { type: String, required: true },
    sequence: { type: Number, default: 0 }
  },
  { timestamps: true }
);

abdmCounterSequenceSchema.index(
  { hospitalId: 1, counterId: 1, dateKey: 1 },
  { unique: true }
);

module.exports = mongoose.model('AbdmCounterSequence', abdmCounterSequenceSchema);
