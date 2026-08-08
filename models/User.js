const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MAIN_FEATURE_KEYS, normalizeFeaturePermissions } = require('../utils/mainFeatureAccess');
const { passwordPolicyErrors } = require('../services/nabhSecurity.service');

// Add to the featurePermissionSchema
const featurePermissionSchema = new mongoose.Schema({
  moduleKey: { type: String, required: true, trim: true, enum: Array.from(MAIN_FEATURE_KEYS) },
  access: { type: String, enum: ['none', 'view', 'manage', 'edit'], default: 'none' },
  actions: [{ type: String, enum: ['approve', 'discount_override', 'refund', 'settlement', 'final_clearance', 'bulk_import_commit', 'user_access_manage', 'ot_approve', 'ot_emergency_bypass', 'stock_adjustment', 'document_sign', 'print_identity_verify', 'mis_export', 'claim_submit', 'claim_manage', 'claim_export', 'preauth_decide', 'rate_card_activate', 'tariff_mapping_approve', 'coverage_reprice', 'coverage_reprice_commit', 'transfer_reserve', 'transfer_approve', 'transfer_complete', 'payroll_publish', 'biometric_manage', 'rate_card_approve', 'pricing_override', 'billing_create', 'billing_edit', 'billing_delete_charge', 'billing_apply_discount', 'billing_finalize'] }],
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
  passwordChangedAt: Date,
  passwordHistory: {
    type: [{
      hash: { type: String, required: true },
      changedAt: { type: Date, default: Date.now }
    }],
    default: [],
    select: false
  },
  failedLoginAttempts: { type: Number, default: 0, min: 0 },
  lockedUntil: Date,
  lastLoginAt: Date,
  lastLoginIp: String,
  mfa: {
    enabled: { type: Boolean, default: false },
    secret: { type: String, select: false },
    pendingSecret: { type: String, select: false },
    enabledAt: Date,
    recoveryCodes: [{ type: String, select: false }]
  },
  sso: {
    provider: String,
    subject: String
  },
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

userSchema.pre('save', async function enforceAndHashPassword(next) {
  if (!this.isModified('password')) return next();

  try {
    const plainPassword = String(this.password || '');
    let policy = {};
    if (this.hospital_id) {
      // Read the configured policy without creating settings from a model hook.
      // The default NABH policy below applies until the hospital saves settings.
      const NabhSetting = require('./NabhSetting');
      const setting = await NabhSetting.findOne({ hospitalId: this.hospital_id })
        .select('security.passwordPolicy')
        .lean();
      policy = setting?.security?.passwordPolicy || {};
    }

    const errors = passwordPolicyErrors(plainPassword, policy);
    if (errors.length) {
      const error = new Error(`Password does not meet the configured policy: ${errors.join('; ')}`);
      error.statusCode = 400;
      error.code = 'PASSWORD_POLICY_VIOLATION';
      error.details = errors;
      return next(error);
    }

    const configuredHistoryCount = Number(policy.historyCount ?? 5);
    const historyCount = Number.isFinite(configuredHistoryCount)
      ? Math.max(0, Math.min(24, configuredHistoryCount))
      : 5;

    if (!this.isNew) {
      const stored = await this.constructor.findById(this._id)
        .select('+passwordHistory')
        .lean();
      if (stored?.password) {
        const recentHashes = [
          stored.password,
          ...(Array.isArray(stored.passwordHistory)
            ? stored.passwordHistory.map((row) => row?.hash).filter(Boolean)
            : [])
        ];
        for (const oldHash of recentHashes.slice(0, historyCount + 1)) {
          if (await bcrypt.compare(plainPassword, oldHash)) {
            const error = new Error('This password was used recently. Choose a different password.');
            error.statusCode = 400;
            error.code = 'PASSWORD_REUSE';
            return next(error);
          }
        }
        this.passwordHistory = historyCount > 0
          ? [
            { hash: stored.password, changedAt: new Date() },
            ...(Array.isArray(stored.passwordHistory) ? stored.passwordHistory : [])
          ].slice(0, historyCount)
          : [];
      }
    }

    this.password = await bcrypt.hash(plainPassword, 12);
    this.passwordChangedAt = new Date();
    return next();
  } catch (error) {
    return next(error);
  }
});

userSchema.methods.matchPassword = async function matchPassword(enteredPassword) {
  if (typeof enteredPassword !== 'string' || !enteredPassword || !this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ hospital_id: 1, email: 1 });
userSchema.index({ lockedUntil: 1 });
userSchema.index({ 'sso.provider': 1, 'sso.subject': 1 }, { sparse: true });

module.exports = mongoose.model('User', userSchema);
