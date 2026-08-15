const mongoose = require('mongoose');

const deficiencySchema = new mongoose.Schema({
  key: { type: String, required: true },
  title: String,
  category: String,
  documentType: String,
  status: { type: String, enum: ['open', 'resolved', 'waived'], default: 'open' },
  detectedAt: { type: Date, default: Date.now },
  resolvedAt: Date,
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: String
}, { _id: false });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  reviewStatus: { type: String, enum: ['pending', 'in_review', 'complete'], default: 'pending', index: true },
  deficiencies: [deficiencySchema],
  lastScannedAt: Date,
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote: String
}, { timestamps: true });

schema.index({ hospitalId: 1, admissionId: 1 }, { unique: true });
schema.index({ hospitalId: 1, reviewStatus: 1, updatedAt: -1 });

module.exports = mongoose.model('MRDRecordReview', schema);
