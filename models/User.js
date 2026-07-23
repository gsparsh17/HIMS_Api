const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MAIN_FEATURE_KEYS, normalizeFeaturePermissions } = require('../utils/mainFeatureAccess');

// Add to the featurePermissionSchema
const featurePermissionSchema = new mongoose.Schema({
  moduleKey: { type: String, required: true, trim: true, enum: Array.from(MAIN_FEATURE_KEYS) },
  access: { type: String, enum: ['none', 'view', 'manage', 'edit'], default: 'none' },
  actions: [{ type: String, enum: ['approve', 'discount_override', 'refund', 'settlement', 'final_clearance', 'bulk_import_commit', 'user_access_manage', 'ot_approve', 'ot_emergency_bypass', 'stock_adjustment', 'document_sign', 'print_identity_verify', 'mis_export', 'claim_submit', 'preauth_decide', 'transfer_reserve', 'transfer_approve', 'transfer_complete', 'payroll_publish', 'biometric_manage', 'rate_card_approve', 'pricing_override'] }],
  grantedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  grantedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['mediqliq_super_admin', 'admin', 'doctor', 'nurse', 'staff', 'patient', 'pharmacy', 'registrar', 'receptionist', 'pathology_staff', 'radiology_staff', 'ot_staff', 'demo', 'hr', 'hr_manager', 'store', 'store_manager', 'inventory_manager', 'accountant', 'equipment_manager', 'insurance_desk', 'bed_manager', 'housekeeping'],
    required: true
  },
  phone: { type: String },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  staff_profile_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile' },
  // Retained for backward compatibility. New code stores the same main feature keys here.
  dashboard_access: [{ type: String }],
  // Deliberately high-level. There are no per-button or per-action access rows in this release.
  modulePermissions: { type: [featurePermissionSchema], default: [] },
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

userSchema.pre('validate', function normalizeFeatureRows(next) {
  // This also converts earlier detailed keys such as ipd.vitals and
  // masters.medicine into the new broad feature keys before validation.
  this.modulePermissions = normalizeFeaturePermissions(
    Array.isArray(this.modulePermissions) ? this.modulePermissions : [],
    this.role,
    { grantedAt: this.createdAt || new Date() }
  );
  next();
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.matchPassword = async function matchPassword(enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ hospital_id: 1, email: 1 });

module.exports = mongoose.model('User', userSchema);
