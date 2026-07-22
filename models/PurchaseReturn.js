const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot', required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  quantity: { type: Number, required: true, min: 0.0001 },
  unitCost: { type: Number, default: 0 },
  reason: String
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  returnNumber: { type: String, required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorePurchaseOrder', required: true },
  grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote' },
  supplierName: String,
  lines: [lineSchema],
  debitCreditReference: String,
  status: { type: String, enum: ['Draft', 'Approved', 'Dispatched', 'Closed', 'Cancelled'], default: 'Draft', index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatchedAt: Date,
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, returnNumber: 1 }, { unique: true });
module.exports = mongoose.model('PurchaseReturn', schema);
