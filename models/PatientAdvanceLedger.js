const mongoose = require('mongoose');

/**
 * Append-only patient advance wallet ledger. balanceAfter is written by the
 * financial service after an atomic admission balance update; historical rows
 * must never be edited or deleted.
 */
const patientAdvanceLedgerSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  walletType: { type: String, enum: ['IPD_SHARED', 'PHARMACY_IPD'], default: 'IPD_SHARED' },
  transactionType: {
    type: String,
    enum: [
      'ADVANCE_DEPOSIT',
      'IPD_INVOICE_DEBIT',
      'PHARMACY_SALE_DEBIT',
      'PHARMACY_RETURN_CREDIT',
      'PHARMACY_OVERPAYMENT_CREDIT',
      'OUTSTANDING_SETTLEMENT_DEBIT',
      'REFUND_PAID',
      'MANUAL_ADJUSTMENT',
      'OPENING_BALANCE',
      'PHARMACY_ADVANCE_REFUND'
    ],
    required: true
  },
  direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 0 },
  openingBalance: { type: Number, default: 0 },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking', 'Wallet', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'],
    default: 'Cash'
  },
  referenceNumber: { type: String, trim: true },
  documentType: { type: String, enum: ['Receipt', 'Invoice', 'Refund', 'Adjustment', 'PharmacySale'], default: 'Receipt' },
  documentId: { type: mongoose.Schema.Types.ObjectId },
  sourceModule: { type: String, enum: ['IPD', 'Pharmacy', 'Billing', 'Manual', 'Discharge'], default: 'IPD' },
  sourceId: { type: mongoose.Schema.Types.ObjectId },
  balanceAfter: { type: Number, required: true },
  status: { type: String, enum: ['POSTED', 'REVERSED', 'VOID'], default: 'POSTED' },
  idempotencyKey: { type: String, trim: true, sparse: true },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

patientAdvanceLedgerSchema.index({ admissionId: 1, walletType: 1, createdAt: -1 });
patientAdvanceLedgerSchema.index({ patientId: 1, createdAt: -1 });
patientAdvanceLedgerSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('PatientAdvanceLedger', patientAdvanceLedgerSchema);
