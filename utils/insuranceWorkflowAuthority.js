'use strict';

const ADMIN_SELF_APPROVAL_ROLES = new Set(['admin', 'mediqliq_super_admin']);
const PERMISSION_MANAGER_ROLES = new Set(['admin', 'mediqliq_super_admin', 'hr', 'hr_manager']);

const DELEGABLE_INSURANCE_ACTIONS = Object.freeze([
  'tariff_mapping_approve',
  'rate_card_approve',
  'rate_card_activate',
  'coverage_reprice',
  'coverage_reprice_commit'
]);

function normalizeRole(value) {
  const role = typeof value === 'object' ? value?.role : value;
  return String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function canUseInsuranceSelfApprovalOverride(user) {
  return ADMIN_SELF_APPROVAL_ROLES.has(normalizeRole(user));
}

function canManageUserPermissions(user) {
  return PERMISSION_MANAGER_ROLES.has(normalizeRole(user));
}

function buildInsuranceAdminOverride(user, reason) {
  return {
    used: true,
    by: user?._id || user?.id,
    at: new Date(),
    role: normalizeRole(user),
    reason
  };
}

module.exports = {
  ADMIN_SELF_APPROVAL_ROLES,
  PERMISSION_MANAGER_ROLES,
  DELEGABLE_INSURANCE_ACTIONS,
  normalizeRole,
  canUseInsuranceSelfApprovalOverride,
  canManageUserPermissions,
  buildInsuranceAdminOverride
};
