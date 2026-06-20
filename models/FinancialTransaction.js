const mongoose = require('mongoose');

/**
 * A financial transaction is a movement of money or a financial adjustment.
 * Bills and invoices describe charges; this collection describes receipts,
 * advances, refunds, credit notes and invoice settlements. It is intentionally
 * append-only: reversals use reversalOf rather than deleting history.
 */
const financialTransactionSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', index: true },
  transactionNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
  transactionType: {
    type: String,
    enum: [
      'RECEIPT',
      'ADVANCE_DEPOSIT',
      'ADVANCE_UTILISATION',
      'ADVANCE_REFUND',
      'REFUND',
      'CREDIT_NOTE',
      'ADJUSTMENT',
      'WRITE_OFF',
      'SETTLEMENT'
    ],
    required: true,
    index: true
  },
  direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'Bank', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'],
    default: 'Cash'
  },
  paymentReference: { type: String, trim: true },
  sourceModule: { type: String, enum: ['IPD', 'Billing', 'Pharmacy', 'OPD', 'Manual', 'Discharge'], default: 'Billing' },
  sourceId: { type: mongoose.Schema.Types.ObjectId },
  status: { type: String, enum: ['POSTED', 'REVERSED', 'VOID'], default: 'POSTED', index: true },
  remarks: { type: String, trim: true },
  idempotencyKey: { type: String, trim: true, sparse: true },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialTransaction' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

financialTransactionSchema.index({ admissionId: 1, createdAt: -1 });
financialTransactionSchema.index({ invoiceId: 1, transactionType: 1, status: 1 });
financialTransactionSchema.index({ patientId: 1, createdAt: -1 });
financialTransactionSchema.index({ hospitalId: 1, transactionType: 1, createdAt: -1 });
financialTransactionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('FinancialTransaction', financialTransactionSchema);
