const mongoose = require('mongoose');

/**
 * A purchase order may refer to an existing local Medicine master or carry a
 * manual/non-NLEM medicine snapshot. A manual line is intentionally not forced
 * to create a Medicine record when the PO is created: cancelled/draft orders
 * should not pollute the active pharmacy master. At first stock receipt the
 * order service materialises a local Medicine record and links medicine_id.
 */
const purchaseOrderItemSchema = new mongoose.Schema({
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: false,
    default: null,
  },
  medicine_name: { type: String, required: true, trim: true },
  catalog_source: {
    type: String,
    enum: ['MASTER', 'MANUAL_NON_NLEM'],
    default: 'MASTER',
    index: true,
  },
  is_non_nlem: { type: Boolean, default: false },
  generic_name: { type: String, trim: true },
  brand: { type: String, trim: true },
  strength: { type: String, trim: true },
  category: { type: String, trim: true },
  base_unit: {
    type: String,
    enum: ['tablet', 'capsule', 'ml', 'vial', 'ampoule', 'bottle', 'tube', 'sachet', 'piece', 'unit', 'other'],
    default: 'tablet',
  },
  pack_unit: {
    type: String,
    enum: ['strip', 'box', 'bottle', 'tube', 'vial', 'ampoule', 'sachet', 'piece', 'unit', 'other'],
    default: 'strip',
  },
  units_per_pack: { type: Number, default: 1, min: 1 },
  hsn_code: { type: String, trim: true },
  gst_rate: { type: Number, min: 0, max: 100 },
  quantity: { type: Number, required: true, min: 1 },
  received: { type: Number, default: 0, min: 0 },
  quantity_base_units: { type: Number, default: 0, min: 0 },
  received_base_units: { type: Number, default: 0, min: 0 },
  unit_cost: { type: Number, required: true, min: 0 },
  total_cost: { type: Number, required: true, min: 0 },
  tax_amount: { type: Number, default: 0, min: 0 },
  batch_number: { type: String, trim: true },
  expiry_date: { type: Date },
  selling_price: { type: Number, default: 0, min: 0 },
  selling_price_per_pack: { type: Number, min: 0 },
  mrp_per_pack: { type: Number, min: 0 },
  materialized_at: { type: Date },
}, { _id: true });

const purchaseOrderSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  order_number: { type: String, unique: true },
  supplier_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
  },
  order_date: { type: Date, default: Date.now },
  expected_delivery: { type: Date },
  status: {
    type: String,
    enum: ['Draft', 'Ordered', 'Received', 'Partially Received', 'Cancelled'],
    default: 'Draft',
  },
  items: [purchaseOrderItemSchema],
  subtotal: { type: Number, required: true, min: 0 },
  tax: { type: Number, default: 0, min: 0 },
  total_amount: { type: Number, required: true, min: 0 },
  notes: { type: String, trim: true },
  received_date: { type: Date },
  invoice_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

purchaseOrderSchema.pre('validate', function validateManualLines(next) {
  for (const item of this.items || []) {
    if (!item.medicine_name || !String(item.medicine_name).trim()) {
      return next(new Error('Every purchase order line requires a medicine name.'));
    }
    if (item.catalog_source === 'MANUAL_NON_NLEM') {
      item.is_non_nlem = true;
    }
  }
  next();
});

purchaseOrderSchema.pre('save', async function generateOrderNumber(next) {
  if (this.isNew && !this.order_number) {
    const count = await mongoose.model('PurchaseOrder').countDocuments();
    this.order_number = `PO-${Date.now()}-${count + 1}`;
  }
  next();
});

purchaseOrderSchema.index({ hospitalId: 1, createdAt: -1 });
purchaseOrderSchema.index({ 'items.medicine_id': 1 });
purchaseOrderSchema.index({ 'items.medicine_name': 1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
