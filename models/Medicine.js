const mongoose = require('mongoose');

const compositionSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  strength: { type: String, trim: true }
}, { _id: false });

const medicineSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  // NLEM is a reference catalogue, not an exclusive purchasing catalogue.
  // Medicines materialised from a manual/non-NLEM PO line remain traceable.
  catalog_source: {
    type: String,
    enum: ['NLEM', 'LOCAL_NON_NLEM', 'MANUAL'],
    default: 'MANUAL',
    index: true
  },
  nlem_code: { type: String, trim: true, index: true, sparse: true },
  created_from_purchase_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', index: true },
  name: { type: String, required: true, trim: true, index: true },
  item_type: {
    type: String,
    enum: ['capex', 'non_capex'],
    default: 'capex',
    index: true
  },
  is_capex: { type: Boolean, default: true, index: true },
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
  dosage_form: { type: String, trim: true, index: true },
  manufacturer_brand_owner: { type: String, trim: true },
  masterSource: {
    key: { type: String, trim: true },
    version: { type: String, trim: true },
    serialNumber: Number,
    checksum: String,
    importedAt: Date
  },

  // ========== TAX INFORMATION (Source of Truth) ==========
  hsn_code: {
    type: String,
    required: false,
    trim: true,
    index: true,
    validate: {
      validator: function (v) {
        return /^\d{4,8}$/.test(v);
      },
      message: 'HSN code must be 4-8 digits'
    }
  },
  gst_rate: {
    type: Number,
    required: false,
    default: 0,
    min: 0,
    max: 100,
    validate: {
      validator: function (v) {
        const validRates = [0, 5, 12, 18, 28];
        return validRates.includes(v);
      },
      message: 'GST rate must be one of: 0, 5, 12, 18, 28'
    }
  },

  taxComplianceStatus: {
    type: String,
    enum: ['verified', 'pending', 'not_applicable'],
    default: 'verified',
    index: true
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
  // Regulatory and High-Risk / Prescription classification
  prescription_required: { type: Boolean, default: false, index: true },
  is_high_risk: { type: Boolean, default: false, index: true },
  is_high_alert: { type: Boolean, default: false, index: true },

  medicationSafety: {
    highRisk: { type: Boolean, default: false, index: true },
    lasa: { type: Boolean, default: false, index: true },
    formularyStatus: {
      type: String,
      enum: ['formulary', 'restricted', 'non_formulary', 'unreviewed'],
      default: 'unreviewed',
      index: true
    },
    alternatives: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' }],
    emergencyMedicine: { type: Boolean, default: false, index: true },
    antimicrobial: { type: Boolean, default: false, index: true },
    antimicrobialClass: { type: String, trim: true },
    requiresDoubleCheck: { type: Boolean, default: false },
    patientBarcodeRequired: { type: Boolean, default: false },
    barcode: { type: String, trim: true, index: true, sparse: true },
    snomedCode: { type: String, trim: true, index: true, sparse: true },
    nrcesCode: { type: String, trim: true, index: true, sparse: true },
    lookAlikeSoundAlikeGroup: { type: String, trim: true, index: true },
    maxDoseInstructions: { type: String, trim: true },
    renalDoseInstructions: { type: String, trim: true },
    pregnancyWarnings: { type: String, trim: true },
    storageWarnings: { type: String, trim: true }
  },
  location: {
    shelf: { type: String },
    rack: { type: String }
  },
  is_active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Pre-save hook for tax history tracking
medicineSchema.pre('save', async function (next) {
  if (!this.units_per_pack || this.units_per_pack < 1) this.units_per_pack = 1;
  if (this.min_stock_level_base_units == null && this.min_stock_level != null) {
    this.min_stock_level_base_units = this.min_stock_level;
  }

  if (!this.manufacturer_brand_owner && this.manufacturer) this.manufacturer_brand_owner = this.manufacturer;
  if (!this.manufacturer && this.manufacturer_brand_owner) this.manufacturer = this.manufacturer_brand_owner;

  // Sync high-risk / high-alert flags with medicationSafety
  if (this.is_high_risk || this.is_high_alert) {
    if (!this.medicationSafety) this.medicationSafety = {};
    this.medicationSafety.highRisk = true;
    this.medicationSafety.requiresDoubleCheck = true;
    this.is_high_risk = true;
    this.is_high_alert = true;
    this.prescription_required = true;
  } else if (this.medicationSafety?.highRisk) {
    this.is_high_risk = true;
    this.is_high_alert = true;
    this.medicationSafety.requiresDoubleCheck = true;
    this.prescription_required = true;
  }

  // Sync capex vs non-capex item type
  const cat = String(this.category || '').toLowerCase();
  const nonCapexKeywords = ['equipment', 'accessory', 'accessories', 'instrument', 'device', 'consumable', 'disposable', 'hardware', 'kit', 'surgical', 'furniture', 'ppe', 'sterilization'];
  if (this.item_type === 'non_capex' || this.is_capex === false || nonCapexKeywords.some(kw => cat.includes(kw))) {
    this.item_type = 'non_capex';
    this.is_capex = false;
  } else {
    this.item_type = 'capex';
    this.is_capex = true;
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
medicineSchema.index({ hospitalId: 1, catalog_source: 1, name: 1 });
medicineSchema.index({ hospitalId: 1, 'medicationSafety.formularyStatus': 1, 'medicationSafety.highRisk': 1 });

module.exports = mongoose.model('Medicine', medicineSchema);