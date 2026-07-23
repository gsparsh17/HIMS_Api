const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  bedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed' },
  bedType: String,
  startedAt: { type: Date, required: true },
  endedAt: Date,
  sourceTransferId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDBedTransfer' },
  pricingSnapshot: mongoose.Schema.Types.Mixed,
  dailyRate: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'closed', 'voided'], default: 'active' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ admissionId: 1, status: 1 });
schema.index({ hospitalId: 1, bedId: 1, startedAt: 1 });
module.exports = mongoose.model('IPDAccommodationSegment', schema);
