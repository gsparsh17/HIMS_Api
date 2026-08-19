const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');

/**
 * Encounter coverage for both OPD appointments and IPD admissions.
 *
 * The historical model name is retained to avoid breaking stored references
 * and populate paths. New code should describe this document as encounter
 * coverage and use encounterType + appointmentId/admissionId.
 */
const admissionCoverageSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  payerCategory: { type: String, enum: ['self', 'pmjay', 'cghs', 'state_scheme', 'echs', 'esic', 'government_other', 'corporate', 'private_insurer', 'tpa', 'tpa_managed', 'other'], required: true },
  tpaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
  planName: String,
  simulationOnly: { type: Boolean, default: false, index: true },
  beneficiary: {
    beneficiaryId: String,
    schemeCardNumber: String,
    policyNumber: String,
    memberId: String,
    relationship: String,
    validFrom: Date,
    validTo: Date,
    coverageLimit: Number,
    coverageLimitUsed: { type: Number, default: 0, min: 0 },
    coPayPercentage: { type: Number, default: 0, min: 0, max: 100 },
    deductibleAmount: { type: Number, default: 0, min: 0 },
    deductibleUsed: { type: Number, default: 0, min: 0 },
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
    consumedAmount: { type: Number, default: 0, min: 0 },
    submittedAt: Date,
    decisionAt: Date,
    validTo: Date,
    decisionReason: String,
    documents: [{ documentId: mongoose.Schema.Types.ObjectId, name: String, url: String, status: String }],
    history: [{ status: String, at: { type: Date, default: Date.now }, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, note: String }],
    enhancements: [{
      enhancementNumber: String,
      requestedAmount: Number,
      approvedAmount: Number,
      status: { type: String, enum: ['draft', 'submitted', 'query', 'approved', 'partially_approved', 'rejected', 'cancelled'], default: 'draft' },
      requestedAt: Date,
      decisionAt: Date,
      reason: String,
      documents: [{ documentId: mongoose.Schema.Types.ObjectId, name: String, url: String, status: String }]
    }],
    queryHistory: [{
      queryNumber: String,
      category: String,
      text: String,
      raisedAt: Date,
      dueAt: Date,
      response: String,
      respondedAt: Date,
      status: { type: String, enum: ['open', 'responded', 'closed'], default: 'open' }
    }]
  },
  schemeData: {
    pmjay: {
      beneficiaryId: { type: String, trim: true },
      pmjayCaseId: { type: String, trim: true, index: true },
      abhaId: { type: String, trim: true },
      bis: {
        status: { type: String, enum: ['not_checked', 'verified', 'failed', 'manual_override'], default: 'not_checked' },
        verificationId: String,
        verifiedAt: Date,
        method: String,
        reason: String
      },
      aadhaarVerificationStatus: { type: String, enum: ['not_checked', 'verified', 'failed', 'not_applicable'], default: 'not_checked' },
      biometric: {
        admissionStatus: { type: String, enum: ['not_checked', 'verified', 'failed', 'exception', 'not_applicable'], default: 'not_checked' },
        dischargeStatus: { type: String, enum: ['not_checked', 'verified', 'failed', 'exception', 'not_applicable'], default: 'not_checked' },
        errorCode: String,
        errorScreenshotUrl: String,
        undertakingDocumentId: mongoose.Schema.Types.ObjectId
      },
      admissionVerificationAt: Date,
      dischargeVerificationAt: Date,
      specialty: { type: String, trim: true },
      packageCode: { type: String, trim: true, uppercase: true },
      packageName: { type: String, trim: true },
      packageType: { type: String, enum: ['medical', 'surgical', 'add_on', 'unspecified_surgical', 'other'] },
      packageRate: Number,
      reservedPackage: { type: Boolean, default: false },
      portability: { type: Boolean, default: false },
      homeState: String,
      treatingState: String,
      caseType: { type: String, enum: ['normal_discharge', 'lama_dama', 'death', 'referred', 'medical_management', 'surgical', 'icu_hdu', 'multiple_procedures', 'portability', 'unspecified_surgical', 'other'], default: 'normal_discharge' },
      provisionalDiagnosis: String,
      finalDiagnosis: String,
      icd10Codes: [{ type: String, trim: true, uppercase: true }],
      procedureCodes: [{ type: String, trim: true, uppercase: true }],
      notes: String
    }
  },
  rateContext: {
    cityTier: { type: String, enum: ['I', 'II', 'III'], default: 'I' },
    accreditation: { type: String, enum: ['non_nabh_non_nabl', 'nabh_nabl', 'super_speciality'], default: 'nabh_nabl' },
    hospitalType: String,
    specialty: String
  },
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard' },
  rateCardVersion: String,
  rateCardFrozenAt: Date,
  fallbackPolicy: { type: String, enum: ['cash_fallback', 'non_admissible', 'block'], default: 'cash_fallback' },
  balanceBillingPolicy: { type: String, enum: ['patient', 'hospital_concession', 'requires_approval', 'not_allowed'], default: 'patient' },
  active: { type: Boolean, default: true, index: true },
  effectiveFrom: { type: Date, default: Date.now },
  effectiveTo: Date,
  revision: { type: Number, default: 1 },
  convertedFromCoverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage' },
  conversionReason: String,
  documentChecklist: [{ code: String, label: String, status: { type: String, enum: ['missing', 'received', 'verified', 'rejected'], default: 'missing' }, documentId: mongoose.Schema.Types.ObjectId, note: String }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

admissionCoverageSchema.pre('validate', function validateEncounter(next) {
  if (this.encounterType === 'IPD' && !this.admissionId) this.invalidate('admissionId', 'admissionId is required for IPD coverage');
  if (this.encounterType === 'OPD' && !this.appointmentId) this.invalidate('appointmentId', 'appointmentId is required for OPD coverage');
  if (this.encounterType === 'IPD') this.appointmentId = undefined;
  if (this.encounterType === 'OPD') this.admissionId = undefined;
  next();
});

admissionCoverageSchema.index({ hospitalId: 1, encounterType: 1, admissionId: 1, active: 1 });
admissionCoverageSchema.index({ hospitalId: 1, encounterType: 1, appointmentId: 1, active: 1 });
admissionCoverageSchema.index(
  { hospitalId: 1, admissionId: 1, active: 1 },
  { unique: true, partialFilterExpression: { encounterType: 'IPD', active: true, admissionId: { $exists: true } } }
);
admissionCoverageSchema.index(
  { hospitalId: 1, appointmentId: 1, active: 1 },
  { unique: true, partialFilterExpression: { encounterType: 'OPD', active: true, appointmentId: { $exists: true } } }
);

addSoftDeleteFields(admissionCoverageSchema);

module.exports = mongoose.model('AdmissionCoverage', admissionCoverageSchema);
