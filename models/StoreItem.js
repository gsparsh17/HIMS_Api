const mongoose = require('mongoose');

function makeCode() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `ST-${y}${m}${d}-${rand}`;
}

const conditionHistorySchema = new mongoose.Schema({
  condition_status: {
    type: String,
    enum: ['New', 'Excellent', 'Good', 'Needs Maintenance', 'Under Maintenance', 'Damaged', 'Condemned', 'Disposed'],
    required: true
  },
  operational_status: {
    type: String,
    enum: ['Available', 'In Use', 'Under Maintenance', 'Out of Service', 'Retired'],
    default: 'Available'
  },
  remarks: { type: String, trim: true },
  checked_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  checked_at: { type: Date, default: Date.now }
}, { _id: true });

const maintenanceRecordSchema = new mongoose.Schema({
  maintenance_date: { type: Date, default: Date.now },
  maintenance_type: {
    type: String,
    enum: ['Preventive', 'Corrective', 'Breakdown', 'Calibration', 'Inspection', 'Warranty', 'Other'],
    default: 'Preventive'
  },
  vendor: { type: String, trim: true },
  vendor_phone: { type: String, trim: true },
  cost: { type: Number, default: 0, min: 0 },
  payment_method: {
    type: String,
    enum: ['Cash', 'Card', 'Bank Transfer', 'UPI', 'Cheque', 'Online'],
    default: 'Bank Transfer'
  },
  description: { type: String, trim: true },
  before_condition: { type: String, trim: true },
  after_condition: {
    type: String,
    enum: ['New', 'Excellent', 'Good', 'Needs Maintenance', 'Under Maintenance', 'Damaged', 'Condemned', 'Disposed']
  },
  next_due_date: { type: Date },
  document_url: { type: String, trim: true },
  expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
  recorded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recorded_at: { type: Date, default: Date.now }
}, { _id: true });

const storeItemSchema = new mongoose.Schema({
  item_code: { type: String, trim: true },
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
  expiry_tracking: { type: Boolean, default: false },
  tracking_policy: { type: String, enum: ['none', 'batch', 'serial', 'batch_and_serial'], default: 'none' },
  valuation_method: { type: String, enum: ['weighted_average', 'fifo', 'actual_lot_cost'], default: 'weighted_average' },
  issue_policy: { type: String, enum: ['FEFO', 'FIFO', 'Manual'], default: 'FEFO' },
  unit_conversions: [{ from_unit: String, to_unit: String, multiplier: Number }],
  current_stock: { type: Number, default: 0, min: 0 },
  minimum_stock: { type: Number, default: 0, min: 0 },
  maximum_stock: { type: Number, default: 0, min: 0 },
  reorder_level: { type: Number, default: 0, min: 0 },
  safety_stock: { type: Number, default: 0, min: 0 },
  lead_time_days: { type: Number, default: 0, min: 0 },
  opening_stock: { type: Number, default: 0, min: 0 },
  average_cost: { type: Number, default: 0, min: 0 },
  last_purchase_price: { type: Number, default: 0, min: 0 },
  tax_rate: { type: Number, default: 0, min: 0, max: 100 },
  preferred_supplier: { type: String, trim: true },
  supplier_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  storage_location: { type: String, trim: true },
  rack_no: { type: String, trim: true },
  expiry_date: { type: Date },
  warranty_expiry: { type: Date },

  // Equipment Specific Fields
  equipment_type: { type: String, trim: true },
  serial_no: { type: String, trim: true },
  barcode: { type: String, trim: true },
  purchase_date: { type: Date },
  purchase_cost: { type: Number, default: 0, min: 0 },
  supplier_phone: { type: String, trim: true },
  supplier_email: { type: String, trim: true, lowercase: true },
  invoice_number: { type: String, trim: true },
  invoice_date: { type: Date },
  payment_method: { type: String, trim: true },
  warranty_start_date: { type: Date },
  department: { type: String, trim: true },
  location: { type: String, trim: true },
  room_no: { type: String, trim: true },
  assigned_to_employee: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile' },
  assigned_to_name: { type: String, trim: true },
  assigned_at: { type: Date },
  condition_status: {
    type: String,
    enum: ['New', 'Excellent', 'Good', 'Needs Maintenance', 'Under Maintenance', 'Damaged', 'Condemned', 'Disposed'],
    default: 'New'
  },
  operational_status: {
    type: String,
    enum: ['Available', 'In Use', 'Under Maintenance', 'Out of Service', 'Retired'],
    default: 'Available'
  },
  criticality: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Critical'],
    default: 'Medium'
  },
  abc_class: { type: String, enum: ['A', 'B', 'C', ''], default: '' },
  ved_class: { type: String, enum: ['Vital', 'Essential', 'Desirable', ''], default: '' },
  fsn_class: { type: String, enum: ['Fast', 'Slow', 'Non Moving', ''], default: '' },
  default_location_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  condition_notes: { type: String, trim: true },
  last_condition_checked_at: { type: Date },
  next_maintenance_due: { type: Date },
  purchase_expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
  maintenance_records: [maintenanceRecordSchema],
  condition_history: [conditionHistorySchema],

  is_active: { type: Boolean, default: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

storeItemSchema.pre('save', function(next) {
  if (!this.item_code) this.item_code = makeCode();
  if (!this.reorder_level && this.minimum_stock) this.reorder_level = this.minimum_stock;
  if (!this.current_stock && this.opening_stock) this.current_stock = this.opening_stock;
  if (this.isModified('condition_status') || this.isModified('operational_status')) {
    this.last_condition_checked_at = new Date();
  }
  next();
});

storeItemSchema.virtual('is_low_stock').get(function() {
  return this.current_stock <= (this.reorder_level || this.minimum_stock || 0);
});

storeItemSchema.virtual('is_under_warranty').get(function() {
  if (!this.warranty_expiry && !this.warranty_expiry_date) return false;
  const expiry = this.warranty_expiry || this.warranty_expiry_date;
  return new Date(expiry) >= new Date();
});

storeItemSchema.virtual('maintenance_overdue').get(function() {
  if (!this.next_maintenance_due) return false;
  return new Date(this.next_maintenance_due) < new Date();
});

storeItemSchema.set('toJSON', { virtuals: true });
storeItemSchema.set('toObject', { virtuals: true });

storeItemSchema.index({ hospital_id: 1, item_code: 1 }, { unique: true });
storeItemSchema.index({ hospital_id: 1, name: 1 });
storeItemSchema.index({ hospital_id: 1, category: 1, is_active: 1 });
storeItemSchema.index({ category: 1 });
storeItemSchema.index({ current_stock: 1, reorder_level: 1 });
storeItemSchema.index({ is_active: 1 });
storeItemSchema.index({ next_maintenance_due: 1 });
storeItemSchema.index({ assigned_to_employee: 1 });
storeItemSchema.index({ condition_status: 1, operational_status: 1 });

module.exports = mongoose.model('StoreItem', storeItemSchema);
