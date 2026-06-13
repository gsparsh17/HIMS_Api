const mongoose = require('mongoose');

const pharmacyLedgerEntrySchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  entryDate: { type: Date, default: Date.now, index: true },
  entryType: {
    type: String,
    enum: [
      'SALE',
      'DUE_CREATED',
      'OUTSTANDING_PAYMENT',
      'RETURN',
      'REFUND',
      'ADVANCE_RECEIVED',
      'ADVANCE_USED',
      'PURCHASE_PAYMENT',
      'DISCOUNT',
      'STOCK_ADJUSTMENT',
      'CREDIT_NOTE',
      'FINAL_CLEARANCE',
      'DOCTOR_COMMISSION_ACCRUAL',
      'DEFERRED_SETTLEMENT'  // Added for bulk deferred payment settlements
    ],
    required: true
  },
  direction: { type: String, enum: ['IN', 'OUT', 'NON_CASH'], required: true },
  amount: { type: Number, required: true, min: 0 },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking', 'Insurance', 'Government Scheme',
      'IPDAdvance', 'PharmacyAdvance', 'Adjustment', 'Credit', 'Deferred', 'BulkDiscount'],
    default: 'Cash'
  },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission' },
  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
  returnId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyReturn' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder' },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

pharmacyLedgerEntrySchema.index({ entryDate: -1, paymentMethod: 1 });
pharmacyLedgerEntrySchema.index({ patientId: 1, entryDate: -1 });
pharmacyLedgerEntrySchema.index({ admissionId: 1, entryDate: -1 });
pharmacyLedgerEntrySchema.index({ entryType: 1, entryDate: -1 });

module.exports = mongoose.model('PharmacyLedgerEntry', pharmacyLedgerEntrySchema);