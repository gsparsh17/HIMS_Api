const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  purchaseOrderLineId: mongoose.Schema.Types.ObjectId,
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true },
  receivedQuantity: { type: Number, required: true, min: 0 },
  acceptedQuantity: { type: Number, default: 0, min: 0 },
  rejectedQuantity: { type: Number, default: 0, min: 0 },
  unitCost: { type: Number, default: 0, min: 0 },
  lotNumber: String,
  serialNumbers: [String],
  manufactureDate: Date,
  expiryDate: Date,
  destinationLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  qcStatus: { type: String, enum: ['Pending', 'Accepted', 'Partially Accepted', 'Rejected'], default: 'Pending' },
  qcNotes: String,
  lotIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InventoryLot' }]
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  grnNumber: { type: String, required: true, index: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorePurchaseOrder', required: true, index: true },
  supplierName: String,
  supplierInvoiceNumber: String,
  supplierInvoiceDate: Date,
  receivedAt: { type: Date, default: Date.now },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inspectedAt: Date,
  lines: [lineSchema],
  attachments: [{ name: String, url: String, mimeType: String }],
  status: { type: String, enum: ['Draft', 'QC Pending', 'Partially Posted', 'Posted', 'Rejected', 'Cancelled'], default: 'Draft', index: true },
  stockPostedAt: Date,
  stockPostedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, grnNumber: 1 }, { unique: true });
module.exports = mongoose.model('GoodsReceiptNote', schema);
