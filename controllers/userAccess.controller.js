'use strict';

const User = require('../models/User');
const { MAIN_FEATURE_KEYS, toMainFeatureKey } = require('../utils/mainFeatureAccess');
const { normalizeRole } = require('../utils/insuranceWorkflowAuthority');

const HR_PERMISSION_MANAGER_ROLES = new Set(['hr', 'hr_manager']);
const ADMIN_ROLES = new Set(['admin', 'mediqliq_super_admin']);

function hrCannotManageTarget(actor, target) {
  return HR_PERMISSION_MANAGER_ROLES.has(normalizeRole(actor)) && ADMIN_ROLES.has(normalizeRole(target));
}

const ALLOWED_ACTIONS = new Set([
  'approve',
  'discount_override',
  'refund',
  'settlement',
  'final_clearance',
  'bulk_import_commit',
  'user_access_manage',
  'ot_approve',
  'ot_emergency_bypass',
  'stock_adjustment',
  'document_sign',
  'print_identity_verify',
  'mis_export',
  'claim_submit',
  'claim_manage',
  'claim_export',
  'preauth_decide',
  'rate_card_activate',
  'tariff_mapping_approve',
  'coverage_reprice',
  'coverage_reprice_commit',
  'transfer_reserve',
  'transfer_approve',
  'transfer_complete',
  'payroll_publish',
  'biometric_manage',
  'rate_card_approve',
  'pricing_override',
  'billing_create',
  'billing_edit',
  'billing_delete_charge',
  'billing_apply_discount',
  'billing_finalize'
]);

function normalizePermissions(rows, actor) {
  if (!Array.isArray(rows)) {
    throw new Error('modulePermissions must be an array');
  }

  const seen = new Set();

  return rows.map((row) => {
    const moduleKey = toMainFeatureKey(row?.moduleKey || row?.featureKey || row?.key);

    if (!MAIN_FEATURE_KEYS.has(moduleKey)) {
      throw new Error(`Unknown module: ${row?.moduleKey}`);
    }

    let access = String(row?.access || 'none').toLowerCase();

    if (access === 'edit') {
      access = 'manage';
    }

    if (!['none', 'view', 'manage'].includes(access)) {
      throw new Error(`Invalid access for ${moduleKey}`);
    }

    if (seen.has(moduleKey)) {
      throw new Error(`Duplicate permission for ${moduleKey}`);
    }

    seen.add(moduleKey);

    const invalidActions = (row?.actions || []).filter((a) => !ALLOWED_ACTIONS.has(a));

    if (invalidActions.length) {
      throw new Error(`Unknown action(s) for ${moduleKey}: ${invalidActions.join(', ')}`);
    }

    return {
      moduleKey,
      access,
      actions: Array.from(new Set(row?.actions || [])),
      grantedBy: actor,
      grantedAt: new Date(),
      updatedAt: new Date()
    };
  });
}

function ensurePermissionManagerActions(permissions, role) {
  if (!HR_PERMISSION_MANAGER_ROLES.has(normalizeRole(role))) return permissions;
  let row = permissions.find((permission) => permission.moduleKey === 'hr_staff');
  if (!row) {
    row = { moduleKey: 'hr_staff', access: 'manage', actions: [], grantedAt: new Date(), updatedAt: new Date() };
    permissions.push(row);
  }
  row.access = 'manage';
  row.actions = Array.from(new Set([...(row.actions || []), 'user_access_manage']));
  row.updatedAt = new Date();
  return permissions;
}

exports.getUsers = async (req, res) => {
  try {
    const filter = req.user.role === 'mediqliq_super_admin'
      ? {}
      : { hospital_id: req.user.hospital_id };

    const users = await User
      .find(filter)
      .select('-password')
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      users
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

exports.createUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      hospital_id,
      modulePermissions = []
    } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'name, email, password and role are required'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    if (await User.exists({ email: normalizedEmail })) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    if (req.user.role !== 'mediqliq_super_admin' &&
        hospital_id &&
        String(hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({
        success: false,
        message: 'Cross-hospital user creation denied'
      });
    }

    if (req.user.role !== 'mediqliq_super_admin' &&
        ['admin', 'mediqliq_super_admin'].includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Only a MediQliq super-admin can create privileged administrator roles'
      });
    }

    const permissions = ensurePermissionManagerActions(normalizePermissions(modulePermissions, req.user._id), role);

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      role,
      hospital_id: hospital_id || req.user.hospital_id,
      modulePermissions: permissions,
      is_active: true
    });

    return res.status(201).json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        is_active: user.is_active,
        modulePermissions: user.modulePermissions
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    const status = error?.name === 'ValidationError' ? 400 : 500;

    return res.status(status).json({
      success: false,
      message: error.message
    });
  }
};

exports.updateUserPermissions = async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      modulePermissions = [],
      role,
      is_active
    } = req.body;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (hrCannotManageTarget(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'HR can manage staff permissions but cannot change hospital administrator or super-admin accounts'
      });
    }

    if (req.user.role !== 'mediqliq_super_admin' &&
        String(user.hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({
        success: false,
        message: 'Cross-hospital update denied'
      });
    }

    if (role &&
        req.user.role !== 'mediqliq_super_admin' &&
        ['admin', 'mediqliq_super_admin'].includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Only a MediQliq super-admin can assign privileged administrator roles'
      });
    }

    const permissions = ensurePermissionManagerActions(normalizePermissions(modulePermissions, req.user._id), role || user.role);

    if (role) {
      user.role = role;
    }

    if (is_active !== undefined) {
      user.is_active = is_active;
    }

    user.modulePermissions = permissions;
    await user.save();

    return res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        is_active: user.is_active,
        modulePermissions: user.modulePermissions
      }
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (hrCannotManageTarget(req.user, user)) {
      return res.status(403).json({
        success: false,
        message: 'HR can manage staff permissions but cannot change hospital administrator or super-admin accounts'
      });
    }

    if (req.user.role !== 'mediqliq_super_admin' &&
        String(user.hospital_id) !== String(req.user.hospital_id)) {
      return res.status(403).json({
        success: false,
        message: 'Cross-hospital update denied'
      });
    }

    user.password = password;
    await user.save();

    return res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};