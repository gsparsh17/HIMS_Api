const mongoose = require('mongoose');

const rateCardSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  name: { type: String, required: true, trim: true },
  version: { type: String, required: true, trim: true },
  currency: { type: String, default: 'INR', uppercase: true },
  effectiveFrom: { type: Date, required: true, index: true },
  effectiveTo: Date,
  status: { type: String, enum: ['draft', 'staging', 'pending_approval', 'pending_activation', 'active', 'closed', 'rejected'], default: 'draft', index: true },
  demoOnly: { type: Boolean, default: false, index: true },
  applicability: {
    cityTiers: [{ type: String, enum: ['I', 'II', 'III', 'X', 'Y', 'Z'] }],
    accreditations: [{ type: String, enum: ['non_nabh_non_nabl', 'nabh_nabl', 'super_speciality'] }],
    wardEntitlements: [{ type: String, enum: ['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care', 'not_applicable'] }]
  },
  rules: {
    baseWard: { type: String, default: 'semi_private' },
    wardFactors: { type: Map, of: Number, default: () => ({ general: 0.95, semi_private: 1, private: 1.05, deluxe: 1.1, icu: 1.2 }) },
    accreditationFactors: { type: Map, of: Number, default: () => ({ non_nabh_non_nabl: 0.85, nabh_nabl: 1, super_speciality: 1.15 }) },
    cityTierFactors: { type: Map, of: Number, default: () => ({ I: 1, II: 0.9, III: 0.8 }) },
    sameOtSession: { type: [Number], default: [1, 0.5, 0.25] },
    bilateralSecondFactor: { type: Number, default: 0.5 },
    withinPackagePeriodFactor: { type: Number, default: 0.75 },
    wardUniformCategories: { type: [String], default: ['radiotherapy', 'investigation', 'day_care', 'minor_no_admission', 'consultation'] },
    missingItemPolicy: { type: String, enum: ['inherit_payer', 'cash_fallback', 'non_admissible', 'block'], default: 'inherit_payer' },
    rounding: { type: String, enum: ['nearest_rupee', 'two_decimals', 'floor', 'ceil'], default: 'two_decimals' }
  },
  source: {
    title: String,
    filename: String,
    checksum: String,
    issueDate: Date,
    effectiveDate: Date,
    pageOrAnnexure: String,
    attachmentUrl: String,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: Date,
    verifiedAgainstSource: { type: Boolean, default: false },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: Date
  },
  approval: {
    firstApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    firstApprovedAt: Date,
    secondApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    secondApprovedAt: Date,
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedAt: Date,
    secondApprovalOverride: {
      used: { type: Boolean, default: false },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      role: String,
      reason: String
    },
    activationOverride: {
      used: { type: Boolean, default: false },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      role: String,
      reason: String
    },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: Date,
    rejectionReason: String
  },
  quality: {
    lastValidatedAt: Date,
    validationVersion: String,
    criticalErrors: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    informational: { type: Number, default: 0 },
    blankNames: { type: Number, default: 0 },
    duplicateCodes: { type: Number, default: 0 },
    invalidRates: { type: Number, default: 0 },
    unmappedItems: { type: Number, default: 0 },
    approvedMappings: { type: Number, default: 0 },
    requiredMappings: { type: Number, default: 0 },
    unavailableItems: { type: Number, default: 0 },
    sourceTraceabilityErrors: { type: Number, default: 0 },
    mappingPending: { type: Number, default: 0 },
    packageScopePending: { type: Number, default: 0 },
    unresolvedSourceNames: { type: Number, default: 0 },
    activationReady: { type: Boolean, default: false },
    issueSummary: [{ code: String, severity: { type: String, enum: ['error', 'warning', 'info'] }, message: String, count: Number }],
    issues: [{ code: String, severity: { type: String, enum: ['error', 'warning', 'info'] }, message: String, itemId: mongoose.Schema.Types.ObjectId, externalCode: String }]
  },
  activationRequirements: {
    requireActiveEmpanelment: { type: Boolean, default: true },
    requireAllBillableMappings: { type: Boolean, default: false },
    minimumApprovedMappingPercentage: { type: Number, default: 0, min: 0, max: 100 },
    requireSourceVerification: { type: Boolean, default: false }
  },
  itemCount: { type: Number, default: 0 },
  revision: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

rateCardSchema.index({ hospitalId: 1, payerId: 1, version: 1 }, { unique: true });
rateCardSchema.index({ hospitalId: 1, payerId: 1, status: 1, effectiveFrom: -1 });

module.exports = mongoose.model('RateCard', rateCardSchema);
