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

  // Composition/molecule support
  composition: { type: String, trim: true, index: true },
  compositions: [compositionSchema],
  composition_keywords: [{ type: String, trim: true, lowercase: true, index: true }],
  manufacturer: { type: String, trim: true },
  
  // ========== TAX INFORMATION (Source of Truth) ==========
  hsn_code: { 
    type: String, 
    required: true,
    trim: true, 
    index: true,
    validate: {
      validator: function(v) {
        return /^\d{4,8}$/.test(v);
      },
      message: 'HSN code must be 4-8 digits'
    }
  },
  gst_rate: { 
    type: Number, 
    required: true,
    default: 0, 
    min: 0, 
    max: 100,
    validate: {
      validator: function(v) {
        const validRates = [0, 5, 12, 18, 28];
        return validRates.includes(v);
      },
      message: 'GST rate must be one of: 0, 5, 12, 18, 28'
    }
  },
  
  // Track GST changes for audit
  gst_history: [{
    hsn_code: String,
    gst_rate: Number,
    effective_from: { type: Date, default: Date.now },
    reason: String,
    changed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],

  // Doctor own-brand and commission reporting
  is_own_brand: { type: Boolean, default: false, index: true },
  commission_doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  commission_type: { type: String, enum: ['None', 'Percentage', 'Fixed'], default: 'None' },
  commission_value: { type: Number, default: 0, min: 0 },

  // Unit configuration
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

  // Legacy field
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

// Pre-save hook for tax history tracking
medicineSchema.pre('save', async function(next) {
  if (!this.units_per_pack || this.units_per_pack < 1) this.units_per_pack = 1;
  if (this.min_stock_level_base_units == null && this.min_stock_level != null) {
    this.min_stock_level_base_units = this.min_stock_level;
  }
  this.composition_keywords = buildCompositionKeywords(this);
  if (this.commission_type === 'None') this.commission_value = 0;
  
  // Track GST/HSN changes
  if (!this.isNew) {
    const original = await this.constructor.findById(this._id);
    if (original && (original.hsn_code !== this.hsn_code || original.gst_rate !== this.gst_rate)) {
      this.gst_history.push({
        hsn_code: original.hsn_code,
        gst_rate: original.gst_rate,
        effective_from: new Date(),
        reason: 'GST rate updated',
        changed_by: this._lastUpdatedBy
      });
    }
  }
  
  this.updated_at = Date.now();
  next();
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

// Indexes
medicineSchema.index({ name: 'text', generic_name: 'text', brand: 'text', composition: 'text', category: 'text' });
medicineSchema.index({ hsn_code: 1, gst_rate: 1 });
medicineSchema.index({ gst_rate: 1, is_active: 1 });

module.exports = mongoose.model('Medicine', medicineSchema);