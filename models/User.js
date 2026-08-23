const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const bcrypt = require('bcryptjs');
const { MAIN_FEATURE_KEYS, normalizeFeaturePermissions } = require('../utils/mainFeatureAccess');
const { passwordPolicyErrors } = require('../services/nabhSecurity.service');
const { PRIVILEGED_ACTIONS } = require('../utils/privilegedActions');

// Add to the featurePermissionSchema
const featurePermissionSchema = new mongoose.Schema({
  moduleKey: { type: String, required: true, trim: true, enum: Array.from(MAIN_FEATURE_KEYS) },
  access: { type: String, enum: ['none', 'view', 'manage', 'edit'], default: 'none' },
  actions: [{ type: String, enum: ['approve', 'discount_override', 'refund', 'settlement', 'final_clearance', 'bulk_import_commit', 'user_access_manage', 'ot_approve', 'ot_emergency_bypass', 'stock_adjustment', 'document_sign', 'print_identity_verify', 'mis_export', 'claim_submit', 'claim_manage', 'claim_export', 'preauth_decide', 'rate_card_activate', 'tariff_mapping_approve', 'coverage_reprice', 'coverage_reprice_commit', 'transfer_reserve', 'transfer_approve', 'transfer_complete', 'payroll_publish', 'biometric_manage', 'rate_card_approve', 'pricing_override', 'billing_create', 'billing_edit', 'billing_delete_charge', 'billing_apply_discount', 'billing_finalize', 'billing_mode_override', 'tax_override', 'ipd_admission_manage', 'ipd_round_write', 'ipd_clinical_write', 'ipd_nursing_write', 'ipd_medication_write', 'ipd_discharge_write', 'ipd_discharge_support', 'ipd_discharge_override', 'pharmacy_finance_access'] }],
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
  // When true, explicit module rows (including `none`) are authoritative. Legacy
  // admins default to false to stay unrestricted; delegated admins and users whose
  // access is saved from Login Access Controls are switched to true.
  enforceModulePermissions: { type: Boolean, default: false },
  // Optional navigation allow-list. Empty means use the normal role sidebar. Entries may
  // be exact paths or prefixes ending in * (for example /dashboard/hr*).
  sidebarAccess: { type: [String], default: [] },
  // Sensitive governance capabilities are intentionally separate from module permissions.
  privilegedActions: [{ type: String, enum: PRIVILEGED_ACTIONS }],
  // Incrementing this value invalidates already-issued staff JWTs without waiting for token expiry.
  securityVersion: { type: Number, default: 1, min: 0, select: true },
  sessionRevokedAt: Date,
  // Deliberately high-level. There are no per-button or per-action access rows in this release.
  modulePermissions: { type: [featurePermissionSchema], default: [] },
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  passwordChangedAt: Date,
  mustChangePassword: { type: Boolean, default: false },
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
  trustedDevices: {
    type: [{
      deviceIdHash: { type: String, required: true },
      label: { type: String, trim: true, maxlength: 120 },
      addedAt: { type: Date, default: Date.now },
      lastSeenAt: Date,
      revokedAt: Date
    }],
    default: [],
    select: false
  },
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
    { grantedAt: this.createdAt || new Date() },
    { preserveExplicitNone: Boolean(this.enforceModulePermissions) }
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
        .select('+passwordHistory securityVersion')
        .lean();
      if (stored?.password) {
        this.securityVersion = Number(stored.securityVersion || 0) + 1;
        this.sessionRevokedAt = new Date();
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


const SECURITY_SENSITIVE_PATHS = [
  'role', 'is_active', 'hospital_id', 'modulePermissions', 'enforceModulePermissions',
  'sidebarAccess', 'privilegedActions', 'mfa.enabled', 'mfa.secret', 'mfa.pendingSecret'
];

function updateTouchesSensitiveSecurity(update = {}) {
  const candidates = [update, update.$set || {}, update.$unset || {}];
  return candidates.some((obj) => SECURITY_SENSITIVE_PATHS.some((path) =>
    Object.prototype.hasOwnProperty.call(obj, path) ||
    Object.keys(obj).some((key) => key.startsWith(`${path}.`))
  ));
}

function hasUserAccessManage(rows = []) {
  return rows.some((row) => Array.isArray(row.actions) && row.actions.includes('user_access_manage'));
}

userSchema.pre('save', async function invalidateSessionsForSecurityChange(next) {
  try {
    if (this.isNew) return next();
    const securityChanged = SECURITY_SENSITIVE_PATHS.some((path) => this.isModified(path));
    if (!securityChanged) return next();

    if ((this.isModified('privilegedActions') || this.isModified('modulePermissions')) && !this.$locals?.allowPrivilegedPermissionChange) {
      const existing = await this.constructor.findById(this._id).select('privilegedActions modulePermissions').lean();
      const oldPriv = JSON.stringify((existing?.privilegedActions || []).slice().sort());
      const newPriv = JSON.stringify((this.privilegedActions || []).slice().sort());
      const oldUA = hasUserAccessManage(existing?.modulePermissions || []);
      const newUA = hasUserAccessManage(this.modulePermissions || []);
      if (oldPriv !== newPriv || oldUA !== newUA) {
        const error = new Error('Privileged permission changes require an approved maker-checker request');
        error.statusCode = 403;
        error.code = 'PRIVILEGED_CHANGE_REQUIRES_APPROVAL';
        return next(error);
      }
    }

    // Password middleware already increments securityVersion itself.
    if (!this.isModified('password') && !this.isModified('securityVersion')) {
      const stored = await this.constructor.findById(this._id).select('securityVersion').lean();
      this.securityVersion = Number(stored?.securityVersion || this.securityVersion || 0) + 1;
    }
    this.sessionRevokedAt = new Date();
    return next();
  } catch (error) {
    return next(error);
  }
});

for (const hook of ['findOneAndUpdate', 'updateOne', 'updateMany']) {
  userSchema.pre(hook, function invalidateQuerySessions(next) {
    const update = this.getUpdate() || {};
    if (!updateTouchesSensitiveSecurity(update)) return next();
    update.$inc = { ...(update.$inc || {}), securityVersion: 1 };
    update.$set = { ...(update.$set || {}), sessionRevokedAt: new Date() };
    this.setUpdate(update);
    next();
  });
}

userSchema.methods.matchPassword = async function matchPassword(enteredPassword) {
  if (typeof enteredPassword !== 'string' || !enteredPassword || !this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

userSchema.index({ hospital_id: 1, email: 1 });
userSchema.index({ lockedUntil: 1 });
userSchema.index({ 'sso.provider': 1, 'sso.subject': 1 }, { sparse: true });

addSoftDeleteFields(userSchema);

module.exports = mongoose.model('User', userSchema);
