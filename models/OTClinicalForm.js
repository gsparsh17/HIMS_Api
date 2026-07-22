const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  templateId: { type: String, required: true, trim: true, index: true },
  templateVersion: { type: Number, required: true, default: 1 },
  title: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true, index: true },
  stage: { type: String, enum: ['preop', 'intraop', 'postop', 'ongoing'], default: 'ongoing', index: true },
  required: { type: Boolean, default: false },
  formData: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['Draft', 'Completed', 'Signed', 'Amended'], default: 'Draft', index: true },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date,
  lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signedAt: Date,
  version: { type: Number, default: 1 },
  amendmentReason: String,
}, { timestamps: true, minimize: false });

schema.index({ hospitalId: 1, caseId: 1, templateId: 1 }, { unique: true });
schema.index({ hospitalId: 1, admissionId: 1, category: 1, updatedAt: -1 });

module.exports = mongoose.model('OTClinicalForm', schema);
