const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  generic_name: { type: String, trim: true },
  brand: { type: String, trim: true },
  category: { type: String, required: true },
  strength: { type: String },
  description: { type: String },

  /**
   * Pharmacy revamp unit model
   * Inventory is valued and consumed in the smallest sellable/consumable unit.
   * Example: 1 strip = 10 tablets, base_unit=tablet, pack_unit=strip, units_per_pack=10.
   */
  base_unit: {
    type: String,
    enum: ['tablet', 'capsule', 'ml', 'vial', 'ampoule', 'bottle', 'tube', 'sachet', 'piece', 'unit', 'other'],
    default: 'tablet'
  },
  pack_unit: {
    type: String,
    enum: ['strip', 'box', 'bottle', 'tube', 'vial', 'ampoule', 'sachet', 'piece', 'unit', 'other'],
    default: 'strip'
  },
  units_per_pack: { type: Number, default: 1, min: 1 },
  allow_loose_sale: { type: Boolean, default: true },
  min_stock_level_base_units: { type: Number, default: 10, min: 0 },

  // Legacy field retained for old screens. New module should read batch.quantity_base_units.
  min_stock_level: { type: Number, default: 10 },
  prescription_required: { type: Boolean, default: false },
  location: {
    shelf: { type: String },
    rack: { type: String }
  },
  is_active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

medicineSchema.pre('save', function(next) {
  if (!this.units_per_pack || this.units_per_pack < 1) this.units_per_pack = 1;
  if (this.min_stock_level_base_units == null && this.min_stock_level != null) {
    this.min_stock_level_base_units = this.min_stock_level;
  }
  this.updated_at = Date.now();
  next();
});

module.exports = mongoose.model('Medicine', medicineSchema);
