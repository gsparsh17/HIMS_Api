const mongoose = require('mongoose');

const clinicalDocumentSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    title: { type: String, required: true },
    documentType: { type: String, required: true, default: 'OTHER' },
    description: String,
    documentDate: { type: Date, default: Date.now, index: true },
    fileUrl: String,
    mimeType: String,
    contentText: String,
    source: String,
    status: { type: String, enum: ['current', 'superseded', 'entered-in-error'], default: 'current' },
    abdmRecordLink: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClinicalDocument', clinicalDocumentSchema);
