const mongoose = require('mongoose');

const medicineBatchSchema = new mongoose.Schema({
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batch_number: { type: String, required: true, index: true },
  expiry_date: { type: Date, required: true, index: true },
  
  // Quantity fields
  quantity: { type: Number, required: true, min: 0, default: 0 },
  quantity_base_units: { type: Number, min: 0 },
  opening_quantity_base_units: { type: Number, min: 0, default: 0 },
  units_per_pack: { type: Number, default: 1, min: 1 },

  // Pricing
  purchase_price: { type: Number, required: true },
  selling_price: { type: Number, required: true },
  purchase_price_per_pack: { type: Number, min: 0 },
  selling_price_per_pack: { type: Number, min: 0 },
  mrp_per_pack: { type: Number, min: 0 },
  purchase_price_per_base_unit: { type: Number, min: 0 },
  selling_price_per_base_unit: { type: Number, min: 0 },

  // ========== TAX SNAPSHOT FOR AUDIT (READ-ONLY) ==========
  tax_snapshot: {
    hsn_code: { type: String },
    gst_rate: { type: Number },
    captured_at: { type: Date, default: Date.now },
    medicine_version: { type: Number } // To track if medicine tax changed later
  },

  supplier_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  purchase_date: { type: Date, default: Date.now },
  received_date: { type: Date },
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

// Pre-validate hook - capture tax snapshot from medicine
medicineBatchSchema.pre('validate', async function(next) {
  try {
    const Medicine = mongoose.model('Medicine');
    const medicine = await Medicine.findById(this.medicine_id);
    
    if (!medicine) {
      return next(new Error('Medicine not found'));
    }
    
    // Inherit units per pack from medicine
    if (!this.units_per_pack || this.units_per_pack < 1) {
      this.units_per_pack = medicine.units_per_pack || 1;
    }

    // Calculate quantities
    if (this.quantity_base_units == null) {
      this.quantity_base_units = this.quantity || 0;
    }
    this.quantity = this.quantity_base_units;

    // Calculate prices
    this.purchase_price_per_pack = this.purchase_price_per_pack ?? this.purchase_price ?? 0;
    this.selling_price_per_pack = this.selling_price_per_pack ?? this.selling_price ?? 0;
    this.mrp_per_pack = this.mrp_per_pack ?? this.selling_price_per_pack ?? 0;
    this.purchase_price_per_base_unit = this.purchase_price_per_base_unit ?? 
      Number((this.purchase_price_per_pack / this.units_per_pack).toFixed(4));
    this.selling_price_per_base_unit = this.selling_price_per_base_unit ?? 
      Number((this.selling_price_per_pack / this.units_per_pack).toFixed(4));
    
    if (!this.opening_quantity_base_units) {
      this.opening_quantity_base_units = this.quantity_base_units;
    }
    
    // ========== CAPTURE TAX SNAPSHOT FROM MEDICINE MASTER ==========
    this.tax_snapshot = {
      hsn_code: medicine.hsn_code,
      gst_rate: medicine.gst_rate,
      captured_at: new Date(),
      medicine_version: medicine.__v || 0
    };
    
    next();
  } catch (error) {
    next(error);
  }
});

// Method to get current tax (always from medicine master)
medicineBatchSchema.methods.getCurrentTax = async function() {
  const Medicine = mongoose.model('Medicine');
  const medicine = await Medicine.findById(this.medicine_id);
  return {
    hsn_code: medicine.hsn_code,
    gst_rate: medicine.gst_rate,
    source: 'medicine_master'
  };
};

// Method to get tax at time of batch creation (for audit)
medicineBatchSchema.methods.getHistoricalTax = function() {
  return {
    hsn_code: this.tax_snapshot?.hsn_code,
    gst_rate: this.tax_snapshot?.gst_rate,
    captured_at: this.tax_snapshot?.captured_at,
    source: 'batch_snapshot'
  };
};

// Virtual fields for tax (derived from medicine master at runtime)
medicineBatchSchema.virtual('hsn_code').get(async function() {
  const tax = await this.getCurrentTax();
  return tax.hsn_code;
});

medicineBatchSchema.virtual('gst_rate').get(async function() {
  const tax = await this.getCurrentTax();
  return tax.gst_rate;
});

medicineBatchSchema.virtual('cgst_rate').get(function() {
  // This would need async resolution - better to compute at query time
  return 0;
});

medicineBatchSchema.virtual('quantity_packs').get(function() {
  return Math.floor((this.quantity_base_units || 0) / (this.units_per_pack || 1));
});

medicineBatchSchema.virtual('quantity_loose_units').get(function() {
  return (this.quantity_base_units || 0) % (this.units_per_pack || 1);
});

// Indexes
medicineBatchSchema.index({ medicine_id: 1, expiry_date: 1, is_active: 1 });
medicineBatchSchema.index({ quantity_base_units: 1 });
medicineBatchSchema.index({ batch_number: 1, medicine_id: 1 });
medicineBatchSchema.index({ 'tax_snapshot.captured_at': 1 }); // For audit queries

module.exports = mongoose.model('MedicineBatch', medicineBatchSchema);