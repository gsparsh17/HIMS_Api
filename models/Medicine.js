const mongoose = require('mongoose');

const compositionSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  strength: { type: String, trim: true }
}, { _id: false });

const medicineSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, index: true },
  generic_name: { type: String, trim: true, index: true },
  brand: { type: String, trim: true, index: true },
  category: { type: String, required: true, index: true },
  strength: { type: String },
  description: { type: String },

  // Composition/molecule support for pharmacy POS search.
  composition: { type: String, trim: true, index: true },
  compositions: [compositionSchema],
  composition_keywords: [{ type: String, trim: true, lowercase: true, index: true }],
  manufacturer: { type: String, trim: true },
  hsn_code: { type: String, trim: true, index: true },
  gst_rate: { type: Number, default: 0, min: 0, max: 100 },

  // Doctor own-brand and commission reporting.
  is_own_brand: { type: Boolean, default: false, index: true },
  commission_doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  commission_type: { type: String, enum: ['None', 'Percentage', 'Fixed'], default: 'None' },
  commission_value: { type: Number, default: 0, min: 0 },

  /**
   * Pharmacy revamp unit model.
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

function buildCompositionKeywords(doc) {
  const tokens = new Set();
  const add = (value) => String(value || '')
    .split(/[,+/|;\s]+/)
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .forEach(v => tokens.add(v));
  add(doc.composition);
  add(doc.generic_name);
  (doc.compositions || []).forEach(c => {
    add(c.name);
    add(c.strength);
  });
  return Array.from(tokens);
}

medicineSchema.pre('save', function(next) {
  if (!this.units_per_pack || this.units_per_pack < 1) this.units_per_pack = 1;
  if (this.min_stock_level_base_units == null && this.min_stock_level != null) this.min_stock_level_base_units = this.min_stock_level;
  this.composition_keywords = buildCompositionKeywords(this);
  if (this.commission_type === 'None') this.commission_value = 0;
  this.updated_at = Date.now();
  next();
});

medicineSchema.index({ name: 'text', generic_name: 'text', brand: 'text', composition: 'text', category: 'text' });

module.exports = mongoose.model('Medicine', medicineSchema);
