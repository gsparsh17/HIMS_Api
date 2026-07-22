const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  relatedCaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', index: true },
  documentType: { type: String, required: true, index: true },
  title: { type: String, required: true },
  sourceModel: { type: String, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sourceRevision: { type: Number, default: 1 },
  templateId: { type: String, required: true, index: true },
  templateVersion: { type: Number, required: true },
  storagePath: { type: String, required: true },
  mimeType: { type: String, default: 'application/pdf' },
  sizeBytes: Number,
  sha256: { type: String, required: true, index: true },
  pageCount: { type: Number, default: 1 },
  signatureIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DocumentSignature' }],
  verificationCodes: [{ type: String }],
  status: { type: String, enum: ['preview', 'final', 'superseded', 'revoked'], default: 'final', index: true },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  generatedAt: { type: Date, default: Date.now },
  supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'RenderedDocument' },
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true, minimize: false });

schema.index({ hospitalId: 1, sourceModel: 1, sourceId: 1, sourceRevision: 1, status: 1 });
module.exports = mongoose.model('RenderedDocument', schema);
