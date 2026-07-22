const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot' },
  systemQuantity: { type: Number, default: 0 },
  countedQuantity: { type: Number, default: 0 },
  varianceQuantity: { type: Number, default: 0 },
  reasonCode: String,
  notes: String
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  countNumber: { type: String, required: true, index: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true, index: true },
  scope: { type: String, enum: ['Full', 'Cycle', 'Item', 'Lot'], default: 'Cycle' },
  freezeAt: Date,
  lines: [lineSchema],
  status: { type: String, enum: ['Planned', 'Counting', 'Review', 'Approved', 'Posted', 'Cancelled'], default: 'Planned', index: true },
  countedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  postedAt: Date,
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, countNumber: 1 }, { unique: true });
module.exports = mongoose.model('StockCount', schema);
