const mongoose = require('mongoose');

function makeAssetCode() {
  const y = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `EQ-${y}-${rand}`;
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

const hospitalEquipmentSchema = new mongoose.Schema({
  asset_code: { type: String, unique: true, trim: true },
  equipment_name: { type: String, required: true, trim: true },
  category: {
    type: String,
    enum: ['Medical Equipment', 'IT Equipment', 'Furniture', 'Electrical', 'Biomedical', 'Lab Equipment', 'Radiology Equipment', 'OT Equipment', 'Ambulance Equipment', 'Utility Equipment', 'Other'],
    default: 'Medical Equipment'
  },
  equipment_type: { type: String, trim: true },
  brand: { type: String, trim: true },
  model_no: { type: String, trim: true },
  serial_no: { type: String, trim: true },
  barcode: { type: String, trim: true },

  purchase_date: { type: Date },
  purchase_cost: { type: Number, default: 0, min: 0 },
  supplier_name: { type: String, trim: true },
  supplier_phone: { type: String, trim: true },
  supplier_email: { type: String, trim: true, lowercase: true },
  invoice_number: { type: String, trim: true },
  invoice_date: { type: Date },
  warranty_start_date: { type: Date },
  warranty_expiry_date: { type: Date },

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
  condition_notes: { type: String, trim: true },
  last_condition_checked_at: { type: Date },
  next_maintenance_due: { type: Date },

  store_item_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem' },
  store_purchase_order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StorePurchaseOrder' },
  purchase_expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },

  maintenance_records: [maintenanceRecordSchema],
  condition_history: [conditionHistorySchema],

  is_active: { type: Boolean, default: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

hospitalEquipmentSchema.pre('save', function(next) {
  if (!this.asset_code) this.asset_code = makeAssetCode();
  if (this.isModified('condition_status') || this.isModified('operational_status')) {
    this.last_condition_checked_at = new Date();
  }
  next();
});

hospitalEquipmentSchema.virtual('is_under_warranty').get(function() {
  if (!this.warranty_expiry_date) return false;
  return new Date(this.warranty_expiry_date) >= new Date();
});

hospitalEquipmentSchema.virtual('maintenance_overdue').get(function() {
  if (!this.next_maintenance_due) return false;
  return new Date(this.next_maintenance_due) < new Date();
});

hospitalEquipmentSchema.index({ hospital_id: 1, asset_code: 1 });
hospitalEquipmentSchema.index({ hospital_id: 1, equipment_name: 1 });
hospitalEquipmentSchema.index({ category: 1, condition_status: 1, operational_status: 1 });
hospitalEquipmentSchema.index({ department: 1, location: 1 });
hospitalEquipmentSchema.index({ assigned_to_employee: 1 });
hospitalEquipmentSchema.index({ store_item_id: 1 });
hospitalEquipmentSchema.index({ store_purchase_order_id: 1 });
hospitalEquipmentSchema.index({ next_maintenance_due: 1 });
hospitalEquipmentSchema.index({ is_active: 1 });

hospitalEquipmentSchema.set('toJSON', { virtuals: true });
hospitalEquipmentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('HospitalEquipment', hospitalEquipmentSchema);
