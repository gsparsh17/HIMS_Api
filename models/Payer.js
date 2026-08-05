const mongoose = require('mongoose');

const payerSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['self', 'pmjay', 'cghs', 'state_scheme', 'echs', 'esic', 'government_other', 'corporate', 'private_insurer', 'tpa', 'other'],
    required: true,
    index: true
  },
  parentPayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
  tpaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer' },
  networkStatus: { type: String, enum: ['network', 'non_network', 'not_applicable'], default: 'not_applicable', index: true },
  demoOnly: { type: Boolean, default: false, index: true },
  empanelment: {
    status: { type: String, enum: ['not_required', 'pending', 'active', 'suspended', 'expired', 'rejected'], default: 'pending' },
    number: { type: String, trim: true },
    effectiveFrom: Date,
    effectiveTo: Date,
    contractReference: { type: String, trim: true }
  },
  contacts: [{ name: String, designation: String, email: String, phone: String }],
  settlementTerms: {
    creditDays: { type: Number, default: 30, min: 0 },
    claimSubmissionDays: { type: Number, default: 7, min: 0 },
    deductionPolicy: { type: String, trim: true },
    notes: { type: String, trim: true }
  },
  pricingPolicy: {
    missingItem: { type: String, enum: ['cash_fallback', 'non_admissible', 'block'], default: 'cash_fallback' },
    balanceBilling: { type: String, enum: ['patient', 'hospital_concession', 'requires_approval', 'not_allowed'], default: 'patient' },
    defaultCoPayPercentage: { type: Number, default: 0, min: 0, max: 100 },
    defaultDeductibleAmount: { type: Number, default: 0, min: 0 },
    requireEligibility: { type: Boolean, default: true },
    requirePreAuthorisation: { type: Boolean, default: false },
    receivableRecognition: { type: String, enum: ['invoice_issue', 'claim_submission'], default: 'invoice_issue' }
  },
  documentChecklist: [{ code: String, label: String, required: { type: Boolean, default: true } }],
  activation: {
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedAt: Date,
    deactivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deactivatedAt: Date,
    reason: String
  },
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

payerSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
payerSchema.index({ hospitalId: 1, name: 1, type: 1 });

module.exports = mongoose.model('Payer', payerSchema);
