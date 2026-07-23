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
  documentChecklist: [{ code: String, label: String, required: { type: Boolean, default: true } }],
  isActive: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

payerSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
payerSchema.index({ hospitalId: 1, name: 1, type: 1 });

module.exports = mongoose.model('Payer', payerSchema);
