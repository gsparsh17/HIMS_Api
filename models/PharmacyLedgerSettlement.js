const mongoose = require('mongoose');

const paymentBreakdownSchema = new mongoose.Schema({
  method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'],
    required: true,
  },
  amount: { type: Number, required: true, min: 0 },
  reference: { type: String, trim: true },
  walletType: { type: String, enum: ['IPD_SHARED', 'PHARMACY_IPD', null], default: null },
}, { _id: false });

const allocationSchema = new mongoose.Schema({
  sale_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', required: true },
  sale_number: { type: String, trim: true },
  bill_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
  invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  opening_due: { type: Number, required: true, min: 0 },
  opening_paid: { type: Number, default: 0, min: 0 },
  gross_amount: { type: Number, default: 0, min: 0 },
  existing_discounts: { type: Number, default: 0, min: 0 },
  payment_allocated: { type: Number, default: 0, min: 0 },
  settlement_discount_allocated: { type: Number, default: 0, min: 0 },
  credit_note_allocated: { type: Number, default: 0, min: 0 },
  unapplied_discount: { type: Number, default: 0, min: 0 },
  closing_due: { type: Number, default: 0, min: 0 },
  payment_breakdown: [paymentBreakdownSchema],
}, { _id: true });

const pharmacyLedgerSettlementSchema = new mongoose.Schema({
  settlement_number: { type: String, unique: true, index: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacy_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },

  status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED', index: true },
  settlement_type: {
    type: String,
    enum: ['FINAL_CONCESSION', 'RETROACTIVE_INVOICE_DISCOUNT'],
    required: true,
  },
  discount_scope: {
    type: String,
    enum: ['UNPAID_DUE', 'FULL_LEDGER_GROSS'],
    required: true,
  },
  discount_type: { type: String, enum: ['PERCENTAGE', 'FIXED'], required: true },
  discount_value: { type: Number, required: true, min: 0 },
  percentage_treatment: {
    type: String,
    enum: ['ADDITIONAL', 'TARGET_TOTAL_DISCOUNT'],
    default: 'ADDITIONAL',
  },
  allocation_policy: {
    type: String,
    enum: ['PROPORTIONAL', 'FIFO', 'LIFO', 'LARGEST_DUE_FIRST', 'SMALLEST_DUE_FIRST', 'MANUAL'],
    default: 'PROPORTIONAL',
  },

  opening_ledger_gross: { type: Number, default: 0, min: 0 },
  opening_ledger_net: { type: Number, default: 0, min: 0 },
  opening_paid_total: { type: Number, default: 0, min: 0 },
  opening_outstanding_total: { type: Number, default: 0, min: 0 },
  existing_discount_total: { type: Number, default: 0, min: 0 },
  calculated_discount: { type: Number, default: 0, min: 0 },
  discount_applied: { type: Number, default: 0, min: 0 },
  discount_unapplied: { type: Number, default: 0, min: 0 },
  payment_received: { type: Number, default: 0, min: 0 },
  patient_credit_created: { type: Number, default: 0, min: 0 },
  patient_credit_disposition: {
    type: String,
    enum: ['NONE', 'PATIENT_CREDIT', 'REFUND_PENDING', 'PHARMACY_ADVANCE', 'IPD_ADJUSTMENT'],
    default: 'NONE',
  },
  patient_credit_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientSettlementCredit' },

  payment_breakdown: [paymentBreakdownSchema],
  allocations: [allocationSchema],
  reason: { type: String, trim: true, required: true },
  notes: { type: String, trim: true },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  idempotency_key: { type: String, trim: true, sparse: true, unique: true },

  reversed_at: { type: Date },
  reversed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reversal_reason: { type: String, trim: true },
  reversal_settlement_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyLedgerSettlement' },
}, { timestamps: true });

pharmacyLedgerSettlementSchema.pre('validate', function preValidate(next) {
  if (this.isNew && !this.settlement_number) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    this.settlement_number = `PLS-${day}-${suffix}`;
  }
  next();
});

pharmacyLedgerSettlementSchema.index({ patient_id: 1, createdAt: -1 });
pharmacyLedgerSettlementSchema.index({ admission_id: 1, createdAt: -1 });

module.exports = mongoose.model('PharmacyLedgerSettlement', pharmacyLedgerSettlementSchema);
