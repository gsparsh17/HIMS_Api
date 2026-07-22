const mongoose = require('mongoose');

const hospitalSequenceSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  key: { type: String, required: true, trim: true },
  value: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

hospitalSequenceSchema.index({ hospitalId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('HospitalSequence', hospitalSequenceSchema);
