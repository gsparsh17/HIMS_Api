const mongoose = require('mongoose');

function makePONumber() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `PO-${y}${m}-${rand}`;
}

const purchaseOrderItemSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  description: { type: String, trim: true },
  quantity: { type: Number, required: true, min: 1 },
  received_quantity: { type: Number, default: 0, min: 0 },
  accepted_quantity: { type: Number, default: 0, min: 0 },
  rejected_quantity: { type: Number, default: 0, min: 0 },
  returned_quantity: { type: Number, default: 0, min: 0 },
  unit: { type: String, default: 'pcs' },
  unit_price: { type: Number, required: true, min: 0 },
  tax_rate: { type: Number, default: 0, min: 0, max: 100 },
  tax_amount: { type: Number, default: 0, min: 0 },
  total_amount: { type: Number, default: 0, min: 0 }
}, { _id: true });

const storePurchaseOrderSchema = new mongoose.Schema({
  po_number: { type: String, unique: true, trim: true },
  supplier_name: { type: String, required: true, trim: true },
  supplier_phone: { type: String, trim: true },
  supplier_email: { type: String, trim: true, lowercase: true },
  supplier_gst: { type: String, trim: true },
  invoice_number: { type: String, trim: true },
  invoice_date: { type: Date },
  order_date: { type: Date, default: Date.now },
  expected_delivery_date: { type: Date },
  received_date: { type: Date },
  items: [purchaseOrderItemSchema],
  subtotal: { type: Number, default: 0, min: 0 },
  tax_amount: { type: Number, default: 0, min: 0 },
  discount_amount: { type: Number, default: 0, min: 0 },
  shipping_amount: { type: Number, default: 0, min: 0 },
  total_amount: { type: Number, default: 0, min: 0 },
  payment_status: { type: String, enum: ['Pending', 'Paid', 'Partially Paid', 'Cancelled'], default: 'Pending' },
  payment_method: { type: String, enum: ['Cash', 'Card', 'Bank Transfer', 'UPI', 'Cheque', 'Online'], default: 'Bank Transfer' },
  status: {
    type: String,
    enum: ['Draft', 'Submitted', 'Approved', 'Dispatched', 'Partially Received', 'QC Pending', 'Partially Posted', 'Received', 'Closed', 'Cancelled'],
    default: 'Draft'
  },
  create_expense: { type: Boolean, default: true },
  expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
  notes: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  received_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revision: { type: Number, default: 1 },
  grn_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote' }],
  terms: String,
  delivery_schedule: [{ expectedDate: Date, quantity: Number, notes: String }]
}, { timestamps: true });

storePurchaseOrderSchema.pre('save', function(next) {
  if (!this.po_number) this.po_number = makePONumber();

  let subtotal = 0;
  let taxTotal = 0;
  this.items.forEach((line) => {
    const lineSubtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
    const lineTax = (lineSubtotal * Number(line.tax_rate || 0)) / 100;
    line.tax_amount = lineTax;
    line.total_amount = lineSubtotal + lineTax;
    subtotal += lineSubtotal;
    taxTotal += lineTax;
  });

  this.subtotal = subtotal;
  this.tax_amount = taxTotal;
  this.total_amount = subtotal + taxTotal + Number(this.shipping_amount || 0) - Number(this.discount_amount || 0);
  next();
});

storePurchaseOrderSchema.index({ hospital_id: 1, order_date: -1 });
storePurchaseOrderSchema.index({ po_number: 1 });
storePurchaseOrderSchema.index({ status: 1 });
storePurchaseOrderSchema.index({ expense_id: 1 });

module.exports = mongoose.model('StorePurchaseOrder', storePurchaseOrderSchema);
