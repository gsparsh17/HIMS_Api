const mongoose = require('mongoose');

const medicineBatchSchema = new mongoose.Schema({
  medicine_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batch_number: { type: String, required: true },
  expiry_date: { type: Date, required: true },

  /**
   * Revamped stock model: quantity_base_units is the source of truth.
   * Legacy quantity is retained for older screens/controllers and is kept in sync.
   */
  quantity: { type: Number, required: true, min: 0, default: 0 },
  quantity_base_units: { type: Number, min: 0 },
  opening_quantity_base_units: { type: Number, min: 0, default: 0 },
  units_per_pack: { type: Number, default: 1, min: 1 },

  purchase_price: { type: Number, required: true }, // legacy per pack
  selling_price: { type: Number, required: true }, // legacy per pack
  purchase_price_per_pack: { type: Number, min: 0 },
  selling_price_per_pack: { type: Number, min: 0 },
  mrp_per_pack: { type: Number, min: 0 },
  purchase_price_per_base_unit: { type: Number, min: 0 },
  selling_price_per_base_unit: { type: Number, min: 0 },

  supplier_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  purchase_date: { type: Date, default: Date.now },
  received_date: { type: Date },
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

medicineBatchSchema.pre('validate', async function(next) {
  try {
    if (!this.units_per_pack || this.units_per_pack < 1) {
      const Medicine = mongoose.model('Medicine');
      const medicine = await Medicine.findById(this.medicine_id).select('units_per_pack');
      this.units_per_pack = medicine?.units_per_pack || 1;
    }

    if (this.quantity_base_units == null) {
      // Treat old quantity as base units to avoid accidental stock multiplication during migration.
      this.quantity_base_units = this.quantity || 0;
    }
    this.quantity = this.quantity_base_units;

    this.purchase_price_per_pack = this.purchase_price_per_pack ?? this.purchase_price ?? 0;
    this.selling_price_per_pack = this.selling_price_per_pack ?? this.selling_price ?? 0;
    this.mrp_per_pack = this.mrp_per_pack ?? this.selling_price_per_pack ?? 0;

    this.purchase_price_per_base_unit = this.purchase_price_per_base_unit ?? Number((this.purchase_price_per_pack / this.units_per_pack).toFixed(4));
    this.selling_price_per_base_unit = this.selling_price_per_base_unit ?? Number((this.selling_price_per_pack / this.units_per_pack).toFixed(4));

    if (!this.opening_quantity_base_units) this.opening_quantity_base_units = this.quantity_base_units;
    next();
  } catch (error) {
    next(error);
  }
});

medicineBatchSchema.virtual('quantity_packs').get(function() {
  return Math.floor((this.quantity_base_units || 0) / (this.units_per_pack || 1));
});

medicineBatchSchema.virtual('quantity_loose_units').get(function() {
  return (this.quantity_base_units || 0) % (this.units_per_pack || 1);
});

medicineBatchSchema.index({ medicine_id: 1, expiry_date: 1, is_active: 1 });
medicineBatchSchema.index({ quantity_base_units: 1 });

module.exports = mongoose.model('MedicineBatch', medicineBatchSchema);
