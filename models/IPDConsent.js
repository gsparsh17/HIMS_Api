const mongoose = require('mongoose');

const signatureSchema = new mongoose.Schema({
  role: { type: String, trim: true },
  name: { type: String, trim: true },
  relation: { type: String, trim: true },
  signedAt: Date,
  method: { type: String, trim: true }
}, { _id: false });

const ipdConsentSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  templateId: { type: String, required: true, trim: true, index: true },
  templateName: { type: String, required: true, trim: true },
  templateVersion: { type: String, trim: true },
  status: { type: String, enum: ['Draft', 'Completed'], default: 'Draft', index: true },
  responses: { type: mongoose.Schema.Types.Mixed, default: {} },
  signatures: [signatureSchema],
  notes: { type: String, trim: true },
  completedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ipdConsentSchema.index({ admissionId: 1, templateId: 1 }, { unique: true });

module.exports = mongoose.model('IPDConsent', ipdConsentSchema);
