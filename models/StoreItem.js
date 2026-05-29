const mongoose = require('mongoose');

function makeCode() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `ST-${y}${m}${d}-${rand}`;
}

const storeItemSchema = new mongoose.Schema({
  item_code: { type: String, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreCategory' },
  item_type: {
    type: String,
    enum: ['consumable', 'asset', 'stationery', 'housekeeping', 'maintenance', 'it', 'medical_non_pharmacy', 'other'],
    default: 'consumable'
  },
  unit: { type: String, default: 'pcs', trim: true },
  hsn_sac: { type: String, trim: true },
  brand: { type: String, trim: true },
  model_no: { type: String, trim: true },
  serial_tracking: { type: Boolean, default: false },
  batch_tracking: { type: Boolean, default: false },
  current_stock: { type: Number, default: 0, min: 0 },
  minimum_stock: { type: Number, default: 0, min: 0 },
  reorder_level: { type: Number, default: 0, min: 0 },
  opening_stock: { type: Number, default: 0, min: 0 },
  average_cost: { type: Number, default: 0, min: 0 },
  last_purchase_price: { type: Number, default: 0, min: 0 },
  tax_rate: { type: Number, default: 0, min: 0, max: 100 },
  preferred_supplier: { type: String, trim: true },
  storage_location: { type: String, trim: true },
  rack_no: { type: String, trim: true },
  expiry_date: { type: Date },
  warranty_expiry: { type: Date },
  is_active: { type: Boolean, default: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeItemSchema.pre('save', function(next) {
  if (!this.item_code) this.item_code = makeCode();
  if (!this.reorder_level && this.minimum_stock) this.reorder_level = this.minimum_stock;
  if (!this.current_stock && this.opening_stock) this.current_stock = this.opening_stock;
  next();
});

storeItemSchema.virtual('is_low_stock').get(function() {
  return this.current_stock <= (this.reorder_level || this.minimum_stock || 0);
});

storeItemSchema.set('toJSON', { virtuals: true });
storeItemSchema.set('toObject', { virtuals: true });

storeItemSchema.index({ hospital_id: 1, name: 1 });
storeItemSchema.index({ item_code: 1 });
storeItemSchema.index({ category: 1 });
storeItemSchema.index({ current_stock: 1, reorder_level: 1 });
storeItemSchema.index({ is_active: 1 });

module.exports = mongoose.model('StoreItem', storeItemSchema);
