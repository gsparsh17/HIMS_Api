const mongoose = require('mongoose');

const storeInventoryTransactionSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lot: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot', index: true },
  serial_number: { type: String, trim: true },
  from_location: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', index: true },
  to_location: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', index: true },
  transaction_type: {
    type: String,
    enum: ['opening', 'purchase', 'issue', 'return', 'adjustment_in', 'adjustment_out', 'damage', 'transfer_out', 'transfer_in', 'reservation', 'reservation_release', 'consume', 'waste', 'purchase_return', 'count_variance'],
    required: true
  },
  quantity: { type: Number, required: true, min: 0 },
  stock_before: { type: Number, required: true, min: 0 },
  stock_after: { type: Number, required: true, min: 0 },
  unit_cost: { type: Number, default: 0, min: 0 },
  total_cost: { type: Number, default: 0, min: 0 },
  reference_model: { type: String, enum: ['StorePurchaseOrder', 'GoodsReceiptNote', 'StoreIssue', 'StoreIssueReturn', 'StoreRequisition', 'StockReservation', 'StockTransfer', 'StockCount', 'PurchaseReturn', 'OTRequest', 'Manual', 'Expense'], default: 'Manual' },
  reference_id: { type: mongoose.Schema.Types.ObjectId },
  department: { type: String, trim: true },
  admission_id: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  ot_case_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', index: true },
  correlation_id: { type: String, trim: true, index: true },
  idempotency_key: { type: String, trim: true },
  reason_code: { type: String, trim: true },
  remarks: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  performed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeInventoryTransactionSchema.index({ hospital_id: 1, createdAt: -1 });
storeInventoryTransactionSchema.index({ item: 1, createdAt: -1 });
storeInventoryTransactionSchema.index({ transaction_type: 1 });
storeInventoryTransactionSchema.index({ hospital_id: 1, reference_model: 1, reference_id: 1 });
storeInventoryTransactionSchema.index({ hospital_id: 1, idempotency_key: 1 }, { unique: true, sparse: true });

storeInventoryTransactionSchema.pre('findOneAndUpdate', function(next) { next(new Error('Inventory transactions are immutable')); });
storeInventoryTransactionSchema.pre('deleteOne', { document: false, query: true }, function(next) { next(new Error('Inventory transactions are immutable')); });

module.exports = mongoose.model('StoreInventoryTransaction', storeInventoryTransactionSchema);
