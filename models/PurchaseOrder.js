const mongoose = require('mongoose');

const purchaseOrderItemSchema = new mongoose.Schema({
  medicine_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Medicine', 
    required: true 
  },
  quantity: { type: Number, required: true, min: 1 },
  unit_cost: { type: Number, required: true },
  total_cost: { type: Number, required: true },
  batch_number: { type: String },
  expiry_date: { type: Date },
  selling_price: { type: Number, default: 0 }
});

const purchaseOrderSchema = new mongoose.Schema({
  order_number: { type: String, unique: true },
  supplier_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Supplier', 
    required: true 
  },
  order_date: { type: Date, default: Date.now },
  expected_delivery: { type: Date },
  status: { 
    type: String, 
    enum: ['Draft', 'Ordered', 'Received', 'Partially Received', 'Cancelled'], 
    default: 'Draft' 
  },
  items: [purchaseOrderItemSchema],
  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  total_amount: { type: Number, required: true },
  notes: { type: String },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { timestamps: true });

// Generate order number before saving
purchaseOrderSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await mongoose.model('PurchaseOrder').countDocuments();
    this.order_number = `PO-${Date.now()}-${count + 1}`;
  }
  next();
});

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);