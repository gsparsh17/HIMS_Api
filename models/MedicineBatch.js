const mongoose = require('mongoose');

const medicineBatchSchema = new mongoose.Schema({
  medicine_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Medicine', 
    required: true 
  },
  batch_number: { type: String, required: true },
  expiry_date: { type: Date, required: true },
  quantity: { type: Number, required: true, min: 0 },
  purchase_price: { type: Number, required: true },
  selling_price: { type: Number, required: true },
  supplier_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Supplier', 
    required: true 
  },
  purchase_date: { type: Date, default: Date.now },
  received_date: { type: Date },
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('MedicineBatch', medicineBatchSchema);