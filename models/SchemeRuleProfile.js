const mongoose = require('mongoose');

/**
 * Versioned hospital/state/package claim rules. National defaults live in code;
 * this model stores SHA/client/hospital overrides without hard-coding one state's
 * advisory into every tenant.
 */
const packageRuleSchema = new mongoose.Schema({
  packageCode: { type: String, trim: true, uppercase: true, index: true },
  specialty: { type: String, trim: true },
  caseType: { type: String, trim: true },
  hospitalEligible: { type: Boolean, default: true },
  diagnosisCodes: [{ type: String, trim: true, uppercase: true }],
  procedureCodes: [{ type: String, trim: true, uppercase: true }],
  requiredEvidenceTypes: [{ type: String, trim: true }],
  requiredDocumentTypes: [{ type: String, trim: true }],
  warnings: [{ code: String, message: String }],
  metadata: mongoose.Schema.Types.Mixed
}, { _id: true, minimize: false });

const schemeRuleProfileSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  schemeType: { type: String, trim: true, lowercase: true, required: true, index: true },
  scopeLevel: { type: String, enum: ['state', 'package', 'hospital'], default: 'hospital', index: true },
  jurisdiction: { type: String, trim: true, default: 'hospital', index: true },
  profileName: { type: String, trim: true, required: true },
  version: { type: String, trim: true, required: true },
  sourceReference: { type: String, trim: true },
  effectiveFrom: { type: Date, default: Date.now, index: true },
  effectiveTo: Date,
  active: { type: Boolean, default: true, index: true },
  rules: {
    requireEligibilityVerified: { type: Boolean, default: true },
    requireBeneficiaryId: { type: Boolean, default: true },
    requirePackageCode: { type: Boolean, default: true },
    requireDiagnosis: { type: Boolean, default: true },
    requireIcd10: { type: Boolean, default: false },
    warnUnsignedClinicalDocuments: { type: Boolean, default: true },
    blockCashCollection: { type: Boolean, default: false },
    requireDayWiseClinicalCoverage: { type: Boolean, default: false },
    requireDischargeSummary: { type: Boolean, default: true },
    requirePreauthWhenCoverageSaysRequired: { type: Boolean, default: true },
    requireClaimAtOrBelowPreauth: { type: Boolean, default: true },
    stateSubmissionDeadlineDays: Number,
    submissionDeadlineSeverity: { type: String, enum: ['warning', 'blocker'], default: 'warning' },
    requiredEvidenceTypes: [{ type: String, trim: true }],
    requiredDocumentTypes: [{ type: String, trim: true }],
    custom: mongoose.Schema.Types.Mixed
  },
  packageRules: [packageRuleSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, minimize: false });

schemeRuleProfileSchema.index({ hospitalId: 1, schemeType: 1, scopeLevel: 1, jurisdiction: 1, version: 1 }, { unique: true });
schemeRuleProfileSchema.index({ hospitalId: 1, schemeType: 1, active: 1, effectiveFrom: -1 });

module.exports = mongoose.model('SchemeRuleProfile', schemeRuleProfileSchema);
