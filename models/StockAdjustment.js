const mongoose = require('mongoose');

const stockAdjustmentSchema = new mongoose.Schema({
  medicine_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Medicine', 
    required: true 
  },
  batch_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MedicineBatch' 
  },
  adjustment_type: { 
    type: String, 
    enum: ['Addition', 'Deduction', 'Correction', 'Damage', 'Expiry'], 
    required: true 
  },
  quantity: { type: Number, required: true },
  reason: { type: String, required: true },
  adjusted_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  reference: { type: String }, // Link to purchase order, sale, etc.
  notes: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('StockAdjustment', stockAdjustmentSchema);