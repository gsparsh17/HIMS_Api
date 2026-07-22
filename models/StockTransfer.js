const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot', required: true },
  serialNumber: String,
  dispatchedQuantity: { type: Number, required: true, min: 0.0001 },
  receivedQuantity: { type: Number, default: 0, min: 0 },
  damagedQuantity: { type: Number, default: 0, min: 0 },
  shortageQuantity: { type: Number, default: 0, min: 0 },
  notes: String
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  transferNumber: { type: String, required: true, index: true },
  fromLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  toLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  lines: [lineSchema],
  status: { type: String, enum: ['Draft', 'Approved', 'Picked', 'In Transit', 'Received', 'Discrepancy', 'Closed', 'Cancelled'], default: 'Draft', index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatchedAt: Date,
  receivedAt: Date,
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, transferNumber: 1 }, { unique: true });
module.exports = mongoose.model('StockTransfer', schema);
