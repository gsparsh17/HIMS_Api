const mongoose = require('mongoose');

const signatureSchema = new mongoose.Schema({
  role: { type: String, trim: true },
  name: { type: String, trim: true },
  relation: { type: String, trim: true },
  signedAt: Date,
  method: { type: String, enum: ['typed', 'drawn', 'uploaded', 'digital-profile', 'biometric', 'other'], default: 'typed' },
  signerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assetId: { type: mongoose.Schema.Types.ObjectId, ref: 'PrintIdentityAsset' },
  capturedData: { type: String, select: false },
  witnessName: String,
  witnessUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const ipdConsentSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  templateId: { type: String, required: true, trim: true, index: true },
  templateName: { type: String, required: true, trim: true },
  templateVersion: { type: String, trim: true },
  formRevision: { type: Number, default: 1 },
  scopeKey: { type: String, required: true, default: 'admission' },
  relatedProcedureId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcedureRequest' },
  relatedOTCaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', index: true },
  status: { type: String, enum: ['Draft', 'Completed', 'Signed', 'Amended', 'Revoked'], default: 'Draft', index: true },
  responses: { type: mongoose.Schema.Types.Mixed, default: {} },
  signatures: [signatureSchema],
  finalDocumentSignatureId: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentSignature' },
  notes: { type: String, trim: true },
  completedAt: Date,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ipdConsentSchema.index({ hospitalId: 1, admissionId: 1, templateId: 1, scopeKey: 1 }, { unique: true });
ipdConsentSchema.index({ hospitalId: 1, patientId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('IPDConsent', ipdConsentSchema);
