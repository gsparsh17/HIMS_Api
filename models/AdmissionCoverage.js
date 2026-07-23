const mongoose = require('mongoose');

const admissionCoverageSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  payerCategory: { type: String, enum: ['self', 'pmjay', 'cghs', 'state_scheme', 'echs', 'esic', 'government_other', 'corporate', 'private_insurer', 'tpa_managed', 'other'], required: true },
  tpaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
  beneficiary: {
    beneficiaryId: String,
    schemeCardNumber: String,
    policyNumber: String,
    memberId: String,
    relationship: String,
    validFrom: Date,
    validTo: Date,
    coverageLimit: Number,
    coPayPercentage: { type: Number, default: 0, min: 0, max: 100 },
    deductibleAmount: { type: Number, default: 0, min: 0 },
    wardEntitlement: { type: String, enum: ['general', 'semi_private', 'private', 'icu', 'day_care', 'not_applicable'], default: 'semi_private' }
  },
  eligibility: {
    status: { type: String, enum: ['pending', 'verified', 'rejected', 'expired', 'emergency_override'], default: 'pending', index: true },
    verifiedAt: Date,
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    method: String,
    responseReference: String,
    reason: String,
    emergencyOverrideExpiresAt: Date,
    emergencyOverrideApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  preAuthorisation: {
    required: { type: Boolean, default: false },
    status: { type: String, enum: ['not_required', 'not_started', 'draft', 'submitted', 'query', 'partially_approved', 'approved', 'rejected', 'expired'], default: 'not_started', index: true },
    requestNumber: String,
    requestedPackageCode: String,
    requestedProcedure: String,
    estimatedAmount: Number,
    approvedAmount: Number,
    submittedAt: Date,
    decisionAt: Date,
    validTo: Date,
    decisionReason: String,
    documents: [{ documentId: mongoose.Schema.Types.ObjectId, name: String, url: String, status: String }],
    history: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String }]
  },
  rateContext: {
    cityTier: { type: String, enum: ['I', 'II', 'III'], default: 'I' },
    accreditation: { type: String, enum: ['non_nabh_non_nabl', 'nabh_nabl', 'super_speciality'], default: 'nabh_nabl' },
    hospitalType: String,
    specialty: String
  },
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard' },
  rateCardVersion: String,
  active: { type: Boolean, default: true, index: true },
  effectiveFrom: { type: Date, default: Date.now },
  effectiveTo: Date,
  revision: { type: Number, default: 1 },
  documentChecklist: [{ code: String, label: String, status: { type: String, enum: ['missing', 'received', 'verified', 'rejected'], default: 'missing' }, documentId: mongoose.Schema.Types.ObjectId, note: String }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

admissionCoverageSchema.index({ hospitalId: 1, admissionId: 1, active: 1 });
admissionCoverageSchema.index({ admissionId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });

module.exports = mongoose.model('AdmissionCoverage', admissionCoverageSchema);
