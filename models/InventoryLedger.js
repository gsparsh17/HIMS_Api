const mongoose = require('mongoose');

const inventoryLedgerSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  pharmacyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', index: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true, index: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch', index: true },
  movementType: {
    type: String,
    enum: ['SALE_OUT', 'RETURN_IN', 'PURCHASE_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'WASTE_OUT', 'OPENING'],
    required: true
  },
  direction: { type: String, enum: ['IN', 'OUT'], required: true },
  quantityBaseUnits: { type: Number, required: true, min: 0 },
  balanceAfterBaseUnits: { type: Number, required: true, min: 0 },
  sourceModule: { type: String, enum: ['PharmacySale', 'PharmacyReturn', 'PurchaseOrder', 'StockAdjustment', 'IPDMedication', 'Manual'], default: 'PharmacySale' },
  sourceId: { type: mongoose.Schema.Types.ObjectId },
  notes: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

inventoryLedgerSchema.index({ medicineId: 1, createdAt: -1 });
inventoryLedgerSchema.index({ batchId: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryLedger', inventoryLedgerSchema);
