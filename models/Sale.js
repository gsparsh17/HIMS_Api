const mongoose = require('mongoose');

const paymentBreakupSchema = new mongoose.Schema({
  transactionGroupId: { type: String, index: true },
  parentGroupId: { type: String, index: true },
  idempotencyKey: { type: String, index: true },
  presentationType: { type: String, trim: true },
  method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance', 'Credit', 'Pending', 'NoPayment', 'Adjustment', 'Deferred'],
    required: true
  },
  amount: { type: Number, required: true, min: 0 },
  reference: { type: String },
  walletType: { type: String, enum: ['IPD_SHARED', 'PHARMACY_IPD', null], default: null }
}, { _id: false });

const saleReturnRefSchema = new mongoose.Schema({
  return_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyReturn' },
  return_number: { type: String },
  amount: { type: Number, default: 0 },
  returned_at: { type: Date, default: Date.now }
}, { _id: false });

const settlementRefSchema = new mongoose.Schema({
  sale_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
  amount: { type: Number, default: 0 },
  settled_at: { type: Date, default: Date.now }
}, { _id: false });

const saleItemSchema = new mongoose.Schema({
  medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
  medicine_name: { type: String, trim: true },
  composition: { type: String, trim: true },
  generic_name: { type: String, trim: true },
  brand: { type: String, trim: true },
  hsn_code: { type: String, trim: true },
  batch_number: { type: String, trim: true },
  expiry_date: { type: Date },

  quantity: { type: Number, required: true, min: 0 },
  quantity_base_units: { type: Number, min: 0 },
  base_unit: { type: String, default: 'unit' },
  pack_unit: { type: String, default: 'unit' },
  units_per_pack: { type: Number, default: 1, min: 1 },
  packs: { type: Number, default: 0, min: 0 },
  loose_units: { type: Number, default: 0, min: 0 },

  unit_price: { type: Number, required: true, min: 0 },
  rate_per_base_unit: { type: Number, min: 0 },
  rate_per_pack: { type: Number, min: 0 },
  gross_amount: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  discount_amount: { type: Number, default: 0 },
  taxable_amount: { type: Number, default: 0 },
  tax_rate: { type: Number, default: 0 },
  cgst_rate: { type: Number, default: 0 },
  sgst_rate: { type: Number, default: 0 },
  cgst_amount: { type: Number, default: 0 },
  sgst_amount: { type: Number, default: 0 },
  tax_amount: { type: Number, default: 0 },
  total_price: { type: Number, default: 0 },
  net_amount: { type: Number, default: 0 },

  purchase_rate_per_base_unit: { type: Number, default: 0, select: false },
  purchase_amount: { type: Number, default: 0, select: false },
  gross_profit: { type: Number, default: 0, select: false },

  prescription_item_id: { type: mongoose.Schema.Types.ObjectId },
  ipd_medication_chart_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDMedicationChart' },
  prescribed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  prescribed_by_name: { type: String, trim: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  doctor_name: { type: String, trim: true },

  is_own_brand: { type: Boolean, default: false },
  commission_doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  commission_type: { type: String, enum: ['None', 'Percentage', 'Fixed'], default: 'None' },
  commission_value: { type: Number, default: 0 },
  commission_amount: { type: Number, default: 0, select: false },

  returned_quantity_base_units: { type: Number, default: 0 },
  returned_amount: { type: Number, default: 0 }
});

const saleSchema = new mongoose.Schema({
  sale_number: { type: String, unique: true },
  invoice_number: { type: String },
  invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacy_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy' },

  customer_type: {
    type: String,
    enum: ['WalkIn', 'OPD', 'IPD', 'Customer', 'Patient', 'walkin', 'patient', 'customer'],
    default: 'WalkIn'
  },
  source_type: { type: String, enum: ['DIRECT', 'OPD_PRESCRIPTION', 'IPD_MEDICATION', 'IPD_RETURN_ADJUSTMENT'], default: 'DIRECT' },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', index: true },
  doctor_name: { type: String, trim: true },

  uhid: { type: String, trim: true, index: true },
  registration_number: { type: String, trim: true, index: true },
  ship_no: { type: String, trim: true, index: true },
  sponsor_type: { type: String, trim: true, default: 'Self' },
  sponsor_name: { type: String, trim: true, default: 'Self' },

  customer_name: { type: String },
  customer_phone: { type: String },
  sale_date: { type: Date, default: Date.now, index: true },
  items: [saleItemSchema],

  gross_amount: { type: Number, default: 0 },
  subtotal: { type: Number, required: true, default: 0 },
  item_discount_amount: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  discount_type: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  discount_amount: { type: Number, default: 0 },
  taxable_amount: { type: Number, default: 0 },
  discount_reason: { type: String },
  discount_approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tax_rate: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total_amount: { type: Number, required: true, default: 0 },
  current_bill_amount: { type: Number, default: 0 },
  total_collected_amount: {
    type: Number,
    default: 0,
    description: 'Total amount actually collected from customer (including overpayment)'
  },
  previous_outstanding: { type: Number, default: 0 },
  amount_paid: { type: Number, default: 0 },
  settlement_amount: { type: Number, default: 0 },
  balance_due: { type: Number, default: 0, index: true },
  closing_outstanding: { type: Number, default: 0 },
  pharmacy_advance_before: { type: Number, default: 0 },
  pharmacy_advance_after: { type: Number, default: 0 },

  payment_method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'IPDAdvance', 'PharmacyAdvance', 'Split', 'Credit', 'Pending', 'NoPayment', 'Adjustment', 'Deferred'],
    required: true,
    default: 'Cash'
  },
  payments: [paymentBreakupSchema],
  transactionGroupId: { type: String, index: true },
  parentGroupId: { type: String, index: true },
  idempotencyKey: { type: String, sparse: true, index: true },
  presentationType: { type: String, trim: true },
  status: {
    type: String,
    enum: ['Completed', 'Pending', 'Cancelled', 'Refunded', 'PartiallyReturned'],
    default: 'Completed'
  },
  prescription_required: { type: Boolean, default: false },
  prescription_details: { type: String },
  notes: { type: String },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  overpayment_amount: { type: Number, default: 0 },
  overpayment_credited_to: { type: String, enum: ['PHARMACY_IPD', 'IPD_SHARED', null], default: null },
  return_amount: { type: Number, default: 0 },
  // Sum of the paid component actually refunded after due-first return allocation.
  // Original receipt rows remain append-only in the ledger.
  refunded_amount: { type: Number, default: 0, min: 0 },
  net_amount_after_returns: { type: Number, default: 0 },
  return_refs: [saleReturnRefSchema],
  settlement_refs: [settlementRefSchema],

  total_purchase_cost: { type: Number, default: 0, select: false },
  gross_profit: { type: Number, default: 0, select: false },
  commission_amount: { type: Number, default: 0, select: false },

  // ========== DEFERRED PAYMENT FIELDS ==========
  payment_deferred: {
    type: Boolean,
    default: false,
    index: true
  },
  // SIMPLIFIED - No validation at all
  deferral_reason: {
    type: String,
    trim: true,
    default: null
  },
  expected_payment_date: {
    type: Date,
    default: null
  },
  include_in_discharge_clearance: {
    type: Boolean,
    default: true,
    index: true
  },
  discharged_settled_at: {
    type: Date,
    default: null
  },
  discharge_settlement_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PharmacyLedgerSettlement',
    default: null
  }
}, { timestamps: true });

saleSchema.pre('validate', function (next) {
  this.items = (this.items || []).map((item) => {
    const qty = item.quantity_base_units ?? item.quantity ?? 0;
    item.quantity_base_units = qty;
    item.quantity = qty;
    item.units_per_pack = item.units_per_pack || 1;
    item.rate_per_base_unit = item.rate_per_base_unit ?? item.unit_price ?? 0;
    item.unit_price = item.unit_price ?? item.rate_per_base_unit;
    item.rate_per_pack = item.rate_per_pack ?? (item.rate_per_base_unit * item.units_per_pack);
    item.packs = Math.floor(qty / item.units_per_pack);
    item.loose_units = qty % item.units_per_pack;
    item.gross_amount = Number((item.gross_amount ?? (qty * item.rate_per_base_unit)).toFixed(2));
    item.taxable_amount = Number((item.taxable_amount ?? Math.max(0, item.gross_amount - (item.discount_amount || 0))).toFixed(2));
    item.tax_amount = Number((item.tax_amount ?? item.taxable_amount * ((item.tax_rate || 0) / 100)).toFixed(2));
    item.cgst_amount = item.cgst_amount ?? Number((item.tax_amount / 2).toFixed(2));
    item.sgst_amount = item.sgst_amount ?? Number((item.tax_amount / 2).toFixed(2));
    item.net_amount = Number((item.net_amount ?? (item.taxable_amount + item.tax_amount)).toFixed(2));
    item.total_price = Number((item.total_price ?? item.net_amount).toFixed(2));
    return item;
  });
  // Zero is valid after a complete return. Older documents may nevertheless
  // hydrate this schema default as 0 even though their persisted field was absent.
  // In that legacy case, infer the open net from total minus recorded returns.
  const inferredNetAfterReturns = Math.max(0, (this.total_amount || 0) - (this.return_amount || 0));
  if (
    this.net_amount_after_returns === undefined ||
    this.net_amount_after_returns === null ||
    (Number(this.net_amount_after_returns) === 0 && inferredNetAfterReturns > 0 && Number(this.return_amount || 0) === 0)
  ) {
    this.net_amount_after_returns = inferredNetAfterReturns;
  }
  next();
});

saleSchema.pre('save', async function (next) {
  if (this.isNew && !this.sale_number) {
    const count = await mongoose.model('Sale').countDocuments();
    this.sale_number = `SH/PC/DII/${String(count + 1).padStart(8, '0')}`;
  }
  next();
});

saleSchema.index({ sale_date: -1 });
saleSchema.index({ customer_type: 1, admission_id: 1 });
saleSchema.index({ source_type: 1 });
saleSchema.index({ patient_id: 1, admission_id: 1, sale_date: -1 });
saleSchema.index({ doctor_id: 1, sale_date: -1 });
saleSchema.index({ payment_deferred: 1, include_in_discharge_clearance: 1, status: 1 });

saleSchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model('Sale', saleSchema);