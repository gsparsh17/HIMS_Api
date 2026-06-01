const mongoose = require('mongoose');

const patientAdvanceLedgerSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  walletType: { type: String, enum: ['IPD_SHARED', 'PHARMACY_IPD'], default: 'IPD_SHARED' },
  transactionType: {
    type: String,
    enum: [
      'ADVANCE_DEPOSIT',
      'PHARMACY_SALE_DEBIT',
      'PHARMACY_RETURN_CREDIT',
      'PHARMACY_OVERPAYMENT_CREDIT',
      'OUTSTANDING_SETTLEMENT_DEBIT',
      'REFUND_PAID',
      'MANUAL_ADJUSTMENT',
      'OPENING_BALANCE'
    ],
    required: true
  },
  direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking', 'Wallet', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'],
    default: 'Cash'
  },
  referenceNumber: { type: String, trim: true },
  sourceModule: { type: String, enum: ['IPD', 'Pharmacy', 'Billing', 'Manual'], default: 'Pharmacy' },
  sourceId: { type: mongoose.Schema.Types.ObjectId },
  balanceAfter: { type: Number, required: true },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

patientAdvanceLedgerSchema.index({ admissionId: 1, walletType: 1, createdAt: -1 });
patientAdvanceLedgerSchema.index({ patientId: 1, createdAt: -1 });

module.exports = mongoose.model('PatientAdvanceLedger', patientAdvanceLedgerSchema);
