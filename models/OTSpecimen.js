const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  specimenNumber: { type: String, required: true, index: true },
  label: { type: String, required: true },
  site: String,
  container: String,
  preservative: String,
  pathologyOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'LabRequest' },
  collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  collectedAt: Date,
  handedOverBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  handedOverAt: Date,
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedAt: Date,
  status: { type: String, enum: ['Collected', 'Handed Over', 'Received', 'Rejected', 'Reported'], default: 'Collected', index: true },
  rejectionReason: String
}, { timestamps: true });

schema.index({ hospitalId: 1, specimenNumber: 1 }, { unique: true });
module.exports = mongoose.model('OTSpecimen', schema);
