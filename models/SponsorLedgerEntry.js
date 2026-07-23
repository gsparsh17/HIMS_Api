const mongoose = require('mongoose');

const sponsorLedgerEntrySchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimCase', index: true },
  chargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' },
  entryNumber: { type: String, required: true },
  entryType: { type: String, enum: ['receivable', 'debit_adjustment', 'credit_adjustment', 'settlement', 'deduction', 'write_off', 'reversal'], required: true },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balanceAfter: { type: Number, default: 0 },
  reference: String,
  reason: String,
  occurredAt: { type: Date, default: Date.now, index: true },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'SponsorLedgerEntry' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, versionKey: false });

sponsorLedgerEntrySchema.index({ hospitalId: 1, entryNumber: 1 }, { unique: true });
sponsorLedgerEntrySchema.index({ hospitalId: 1, payerId: 1, occurredAt: 1 });

module.exports = mongoose.model('SponsorLedgerEntry', sponsorLedgerEntrySchema);
