const mongoose = require('mongoose');

const ehrBundleSchema = new mongoose.Schema({
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true,
    index: true
  },
  abhaNumber: {
    type: String,
    index: true
  },
  abhaAddress: {
    type: String,
    index: true
  },
  bundleType: {
    type: String,
    enum: [
      'EMR_SUMMARY',
      'OP_CONSULT',
      'PRESCRIPTION',
      'DIAGNOSTIC_REPORT',
      'DISCHARGE_SUMMARY',
      'OP_CONSULTATION',
      'IMMUNIZATION_RECORD',
      'HEALTH_DOCUMENT_RECORD',
      'WELLNESS_RECORD',
      'INVOICE'
    ],
    default: 'EMR_SUMMARY'
  },
  status: {
    type: String,
    enum: ['generated', 'ready_for_consent', 'consent_requested', 'shared', 'failed'],
    default: 'generated'
  },
  sourceModules: [String],
  recordCounts: {
    appointments: { type: Number, default: 0 },
    admissions: { type: Number, default: 0 },
    prescriptions: { type: Number, default: 0 },
    labReports: { type: Number, default: 0 },
    radiologyReports: { type: Number, default: 0 },
    dischargeSummaries: { type: Number, default: 0 }
  },
  bundle: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  consentRequest: {
    requestId: String,
    status: String,
    requestedAt: Date,
    expiresAt: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

ehrBundleSchema.index({ patientId: 1, createdAt: -1 });
ehrBundleSchema.index({ abhaAddress: 1, createdAt: -1 });
ehrBundleSchema.index({ status: 1 });

module.exports = mongoose.model('EHRBundle', ehrBundleSchema);
