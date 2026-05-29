const mongoose = require('mongoose');

const storeInventoryTransactionSchema = new mongoose.Schema({
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  transaction_type: {
    type: String,
    enum: ['opening', 'purchase', 'issue', 'return', 'adjustment_in', 'adjustment_out', 'damage', 'transfer'],
    required: true
  },
  quantity: { type: Number, required: true, min: 0 },
  stock_before: { type: Number, required: true, min: 0 },
  stock_after: { type: Number, required: true, min: 0 },
  unit_cost: { type: Number, default: 0, min: 0 },
  total_cost: { type: Number, default: 0, min: 0 },
  reference_model: { type: String, enum: ['StorePurchaseOrder', 'StoreIssue', 'StoreRequisition', 'Manual', 'Expense'], default: 'Manual' },
  reference_id: { type: mongoose.Schema.Types.ObjectId },
  department: { type: String, trim: true },
  remarks: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  performed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeInventoryTransactionSchema.index({ hospital_id: 1, createdAt: -1 });
storeInventoryTransactionSchema.index({ item: 1, createdAt: -1 });
storeInventoryTransactionSchema.index({ transaction_type: 1 });
storeInventoryTransactionSchema.index({ reference_model: 1, reference_id: 1 });

module.exports = mongoose.model('StoreInventoryTransaction', storeInventoryTransactionSchema);
