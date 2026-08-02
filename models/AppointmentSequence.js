const mongoose = require('mongoose');

const appointmentSequenceSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  prefix: { type: String, enum: ['OPD', 'IPD'], required: true },
  dateKey: { type: String, required: true },
  value: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

appointmentSequenceSchema.index({ hospitalId: 1, prefix: 1, dateKey: 1 }, { unique: true });
module.exports = mongoose.model('AppointmentSequence', appointmentSequenceSchema);
