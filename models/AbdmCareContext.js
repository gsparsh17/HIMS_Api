const mongoose = require('mongoose');

const recordReferenceSchema = new mongoose.Schema(
  {
    model: String,
    recordId: mongoose.Schema.Types.ObjectId
  },
  { _id: false }
);

const abdmCareContextSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    patientReference: { type: String, required: true, index: true },
    referenceNumber: { type: String, required: true, unique: true, index: true },
    display: { type: String, required: true },
    hiType: {
      type: String,
      required: true,
      enum: [
        'PRESCRIPTION',
        'DIAGNOSTIC_REPORT',
        'OP_CONSULTATION',
        'DISCHARGE_SUMMARY',
        'IMMUNIZATION_RECORD',
        'HEALTH_DOCUMENT_RECORD',
        'WELLNESS_RECORD',
        'INVOICE'
      ],
      index: true
    },
    records: [recordReferenceSchema],
    dateFrom: Date,
    dateTo: Date,
    abhaAddress: { type: String, index: true },
    abhaNumber: { type: String, index: true },
    linkStatus: {
      type: String,
      enum: ['LOCAL_RECORD_READY', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'],
      default: 'LOCAL_RECORD_READY',
      index: true
    },
    linkRequestId: { type: String, index: true },
    linkTransactionId: String,
    linkReferenceNumber: String,
    linkedAt: Date,
    lastNotifiedAt: Date,
    active: { type: Boolean, default: true, index: true },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

abdmCareContextSchema.index({ patientId: 1, hiType: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmCareContext', abdmCareContextSchema);
