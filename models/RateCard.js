const mongoose = require('mongoose');

const rateCardSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  name: { type: String, required: true, trim: true },
  version: { type: String, required: true, trim: true },
  currency: { type: String, default: 'INR', uppercase: true },
  effectiveFrom: { type: Date, required: true, index: true },
  effectiveTo: Date,
  status: { type: String, enum: ['draft', 'staging', 'pending_approval', 'active', 'closed', 'rejected'], default: 'draft', index: true },
  applicability: {
    cityTiers: [{ type: String, enum: ['I', 'II', 'III', 'X', 'Y', 'Z'] }],
    accreditations: [{ type: String, enum: ['non_nabh_non_nabl', 'nabh_nabl', 'super_speciality'] }],
    wardEntitlements: [{ type: String, enum: ['general', 'semi_private', 'private', 'icu', 'day_care', 'not_applicable'] }]
  },
  rules: {
    baseWard: { type: String, default: 'semi_private' },
    wardFactors: { type: Map, of: Number, default: () => ({ general: 0.95, semi_private: 1, private: 1.05 }) },
    accreditationFactors: { type: Map, of: Number, default: () => ({ non_nabh_non_nabl: 0.85, nabh_nabl: 1, super_speciality: 1.15 }) },
    cityTierFactors: { type: Map, of: Number, default: () => ({ I: 1, II: 0.9, III: 0.8 }) },
    sameOtSession: { type: [Number], default: [1, 0.5, 0.25] },
    bilateralSecondFactor: { type: Number, default: 0.5 },
    withinPackagePeriodFactor: { type: Number, default: 0.75 },
    wardUniformCategories: { type: [String], default: ['radiotherapy', 'investigation', 'day_care', 'minor_no_admission', 'consultation'] },
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
    uploadedAt: Date
  },
  approval: {
    firstApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    firstApprovedAt: Date,
    secondApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    secondApprovedAt: Date,
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedAt: Date,
    rejectionReason: String
  },
  itemCount: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

rateCardSchema.index({ hospitalId: 1, payerId: 1, version: 1 }, { unique: true });
rateCardSchema.index({ hospitalId: 1, payerId: 1, status: 1, effectiveFrom: -1 });

module.exports = mongoose.model('RateCard', rateCardSchema);
