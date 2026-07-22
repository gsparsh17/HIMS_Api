const mongoose = require('mongoose');

const locationBalanceSchema = new mongoose.Schema({
  locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  onHand: { type: Number, default: 0, min: 0 },
  reserved: { type: Number, default: 0, min: 0 },
  available: { type: Number, default: 0, min: 0 },
  lastMovementAt: Date
}, { _id: false });

const inventoryLotSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem', required: true, index: true },
  lotNumber: { type: String, trim: true },
  serialNumber: { type: String, trim: true },
  manufactureDate: Date,
  expiryDate: { type: Date, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  supplierName: String,
  grnId: { type: mongoose.Schema.Types.ObjectId, ref: 'GoodsReceiptNote' },
  unitCost: { type: Number, default: 0, min: 0 },
  qualityStatus: { type: String, enum: ['Pending QC', 'Accepted', 'Rejected', 'Quarantined', 'Recalled'], default: 'Pending QC', index: true },
  recallReason: String,
  recalledAt: Date,
  totalOnHand: { type: Number, default: 0, min: 0 },
  totalReserved: { type: Number, default: 0, min: 0 },
  totalAvailable: { type: Number, default: 0, min: 0 },
  locationBalances: [locationBalanceSchema],
  barcode: { type: String, trim: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

inventoryLotSchema.pre('validate', function(next) {
  this.locationBalances.forEach((balance) => {
    balance.available = Math.max(0, Number(balance.onHand || 0) - Number(balance.reserved || 0));
  });
  this.totalOnHand = this.locationBalances.reduce((sum, row) => sum + Number(row.onHand || 0), 0);
  this.totalReserved = this.locationBalances.reduce((sum, row) => sum + Number(row.reserved || 0), 0);
  this.totalAvailable = this.locationBalances.reduce((sum, row) => sum + Number(row.available || 0), 0);
  next();
});

inventoryLotSchema.index({ hospitalId: 1, itemId: 1, lotNumber: 1, serialNumber: 1 }, { unique: true, sparse: true });
inventoryLotSchema.index({ hospitalId: 1, itemId: 1, qualityStatus: 1, expiryDate: 1 });

module.exports = mongoose.model('InventoryLot', inventoryLotSchema);
