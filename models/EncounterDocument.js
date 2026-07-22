const mongoose = require('mongoose');

const encounterDocumentSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  encounterType: { type: String, enum: ['IPD', 'OPD', 'Emergency', 'Other'], default: 'IPD' },
  category: { type: String, required: true, index: true },
  documentType: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true },
  sourceModel: { type: String, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceRevision: { type: Number, default: 1 },
  rendererKey: { type: String, required: true },
  status: {
    type: String,
    enum: ['Not Started', 'Draft', 'Completed/Unsigned', 'Final/Signed', 'Superseded', 'Entered in Error'],
    default: 'Draft',
    index: true
  },
  relatedCaseId: { type: mongoose.Schema.Types.ObjectId },
  relatedCaseType: { type: String, trim: true },
  documentDate: { type: Date, default: Date.now, index: true },
  authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: { type: String, trim: true },
  fileUrl: { type: String, trim: true },
  mimeType: { type: String, trim: true },
  templateId: { type: String, trim: true },
  templateVersion: { type: String, trim: true },
  required: { type: Boolean, default: false },
  signedDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'DocumentSignature' },
  metadata: mongoose.Schema.Types.Mixed,
  visibility: { type: String, enum: ['clinical', 'financial', 'restricted'], default: 'clinical' }
}, { timestamps: true });

encounterDocumentSchema.index(
  { hospitalId: 1, sourceModel: 1, sourceId: 1, sourceRevision: 1 },
  { unique: true }
);
encounterDocumentSchema.index({ hospitalId: 1, admissionId: 1, category: 1, documentDate: 1 });

module.exports = mongoose.model('EncounterDocument', encounterDocumentSchema);
