const mongoose = require('mongoose');

const paymentBreakupSchema = new mongoose.Schema({
  method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'IPDAdvance', 'PharmacyAdvance', 'Credit', 'Pending'],
    required: true
  },
  amount: { type: Number, required: true, min: 0 },
  reference: { type: String },
  walletType: { type: String, enum: ['IPD_SHARED', 'PHARMACY_IPD', null], default: null }
}, { _id: false });

const saleItemSchema = new mongoose.Schema({
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batch_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  medicine_name: { type: String, trim: true },
  batch_number: { type: String, trim: true },

  // Base-unit billing. quantity is retained as alias for old screens.
  quantity: { type: Number, required: true, min: 0 },
  quantity_base_units: { type: Number, min: 0 },
  base_unit: { type: String, default: 'unit' },
  pack_unit: { type: String, default: 'unit' },
  units_per_pack: { type: Number, default: 1, min: 1 },
  packs: { type: Number, default: 0, min: 0 },
  loose_units: { type: Number, default: 0, min: 0 },

  unit_price: { type: Number, required: true, min: 0 }, // alias of rate_per_base_unit
  rate_per_base_unit: { type: Number, min: 0 },
  rate_per_pack: { type: Number, min: 0 },
  gross_amount: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  discount_amount: { type: Number, default: 0 },
  total_price: { type: Number, default: 0 },

  prescription_item_id: { type: mongoose.Schema.Types.ObjectId },
  ipd_medication_chart_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDMedicationChart' }
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
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient'
  },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },

  customer_name: { type: String },
  customer_phone: { type: String },
  sale_date: { type: Date, default: Date.now },
  items: [saleItemSchema],
  subtotal: { type: Number, required: true, default: 0 },
  discount: { type: Number, default: 0 },
  discount_type: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
  discount_amount: { type: Number, default: 0 },
  discount_reason: { type: String },
  discount_approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  tax_rate: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total_amount: { type: Number, required: true, default: 0 },
  amount_paid: { type: Number, default: 0 },
  balance_due: { type: Number, default: 0 },
  payment_method: {
    type: String,
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'IPDAdvance', 'PharmacyAdvance', 'Split', 'Credit', 'Pending'],
    required: true,
    default: 'Cash'
  },
  payments: [paymentBreakupSchema],
  status: {
    type: String,
    enum: ['Completed', 'Pending', 'Cancelled', 'Refunded', 'PartiallyReturned'],
    default: 'Completed'
  },
  prescription_required: { type: Boolean, default: false },
  prescription_details: { type: String },
  notes: { type: String },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

saleSchema.pre('validate', function(next) {
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
    item.gross_amount = Number((qty * item.rate_per_base_unit).toFixed(2));
    item.total_price = Number((item.gross_amount - (item.discount_amount || 0)).toFixed(2));
    return item;
  });
  next();
});

saleSchema.pre('save', async function(next) {
  if (this.isNew && !this.sale_number) {
    const count = await mongoose.model('Sale').countDocuments();
    this.sale_number = `SALE-${Date.now()}-${count + 1}`;
  }
  next();
});

saleSchema.index({ sale_date: -1 });
saleSchema.index({ customer_type: 1, admission_id: 1 });
saleSchema.index({ source_type: 1 });

module.exports = mongoose.model('Sale', saleSchema);
