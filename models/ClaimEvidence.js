const mongoose = require('mongoose');

/**
 * Canonical claim evidence links a clinical/financial document to a claim without
 * duplicating the source record. The same evidence model is intentionally usable
 * for PMJAY, CGHS, TPA and private-insurer workflows.
 */
const claimEvidenceSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimCase', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  procedureId: { type: mongoose.Schema.Types.ObjectId, index: true },
  sourceModel: { type: String, trim: true, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, index: true },
  documentId: { type: mongoose.Schema.Types.ObjectId, index: true },
  fileUrl: { type: String, trim: true },
  evidenceType: {
    type: String,
    enum: [
      'ADMISSION_PATIENT', 'PRE_PROCEDURE', 'INTRA_PROCEDURE', 'POST_PROCEDURE',
      'POST_OP_SCAR', 'ICU', 'HDU', 'WARD', 'IMPLANT_STICKER', 'DEVICE_STICKER',
      'IMAGING', 'INVESTIGATION_REPORT', 'OT_NOTE', 'ANAESTHESIA_NOTE',
      'DISCHARGE_SUMMARY', 'BILL', 'INVOICE', 'RECEIPT', 'BIOMETRIC_ERROR',
      'QUERY_RESPONSE', 'OTHER'
    ],
    default: 'OTHER',
    index: true
  },
  evidenceStage: { type: String, enum: ['eligibility', 'admission', 'preop', 'intraop', 'postop', 'discharge', 'financial', 'query', 'supporting'], default: 'supporting', index: true },
  capturedAt: Date,
  bodySite: { type: String, trim: true },
  laterality: { type: String, enum: ['', 'left', 'right', 'bilateral', 'midline', 'not_applicable'], default: '' },
  caption: { type: String, trim: true },
  patientIdentityVisible: { type: Boolean, default: false },
  clinicalSiteVisible: { type: Boolean, default: false },
  patientDateVisible: { type: Boolean, default: false },
  status: { type: String, enum: ['current', 'superseded', 'entered_in_error'], default: 'current', index: true },
  metadata: mongoose.Schema.Types.Mixed,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

claimEvidenceSchema.index({ hospitalId: 1, claimId: 1, evidenceType: 1, status: 1 });
claimEvidenceSchema.index({ hospitalId: 1, claimId: 1, sourceModel: 1, sourceId: 1, evidenceType: 1 });

module.exports = mongoose.model('ClaimEvidence', claimEvidenceSchema);
