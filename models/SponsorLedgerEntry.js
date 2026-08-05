const mongoose = require('mongoose');

const sponsorLedgerEntrySchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], default: 'IPD', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', index: true },
  claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClaimCase', index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', index: true },
  chargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' },
  entryNumber: { type: String, required: true },
  entryType: { type: String, enum: ['receivable', 'debit_adjustment', 'credit_adjustment', 'settlement', 'deduction', 'write_off', 'reversal'], required: true },
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balanceAfter: { type: Number, default: 0 },
  reference: String,
  reason: String,
  sourceType: { type: String, enum: ['invoice', 'claim', 'settlement', 'repricing', 'manual', 'reversal'], default: 'manual' },
  sourceId: mongoose.Schema.Types.ObjectId,
  idempotencyKey: { type: String, trim: true },
  reconciliationStatus: { type: String, enum: ['unreconciled', 'partially_reconciled', 'reconciled', 'disputed'], default: 'unreconciled', index: true },
  occurredAt: { type: Date, default: Date.now, index: true },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'SponsorLedgerEntry' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, versionKey: false });

sponsorLedgerEntrySchema.index({ hospitalId: 1, entryNumber: 1 }, { unique: true });
sponsorLedgerEntrySchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
sponsorLedgerEntrySchema.index({ hospitalId: 1, payerId: 1, occurredAt: 1 });

module.exports = mongoose.model('SponsorLedgerEntry', sponsorLedgerEntrySchema);
