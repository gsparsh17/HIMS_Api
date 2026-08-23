'use strict';

const PRIVILEGED_ACTIONS = Object.freeze([
  'audit_log_view',
  'audit_log_export',
  'patient_identity_export_unmasked',
  'global_clinical_override',
  'abha_association_retire',
  'break_glass_initiate',
  'break_glass_review',
  'privileged_access_request',
  'privileged_access_approve',
  'abdm_reconciliation_view',
  'abdm_reconciliation_manage'
]);

// Actions in this set are never granted/revoked directly. A maker creates a
// PrivilegedAccessRequest and a distinct checker approves/rejects it.
const DUAL_CONTROL_ACTIONS = Object.freeze([
  'user_access_manage',
  'audit_log_export',
  'patient_identity_export_unmasked',
  'global_clinical_override'
]);

const PRIVILEGED_ACTION_SET = new Set(PRIVILEGED_ACTIONS);
const DUAL_CONTROL_ACTION_SET = new Set(DUAL_CONTROL_ACTIONS);

function hasPrivilegedAction(user, action) {
  if (!user || !PRIVILEGED_ACTION_SET.has(action)) return false;
  if (String(user.role || '').toLowerCase() === 'mediqliq_super_admin') return true;
  return Array.isArray(user.privilegedActions) && user.privilegedActions.includes(action);
}

module.exports = {
  PRIVILEGED_ACTIONS,
  PRIVILEGED_ACTION_SET,
  DUAL_CONTROL_ACTIONS,
  DUAL_CONTROL_ACTION_SET,
  hasPrivilegedAction
};
