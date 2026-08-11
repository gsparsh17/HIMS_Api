'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canUseInsuranceSelfApprovalOverride,
  canManageUserPermissions,
  DELEGABLE_INSURANCE_ACTIONS
} = require('../utils/insuranceWorkflowAuthority');
const { roleDefaultActions } = require('../utils/mainFeatureAccess');

test('only administrator roles can bypass insurance four-eyes checks', () => {
  assert.equal(canUseInsuranceSelfApprovalOverride({ role: 'admin' }), true);
  assert.equal(canUseInsuranceSelfApprovalOverride({ role: 'mediqliq_super_admin' }), true);
  assert.equal(canUseInsuranceSelfApprovalOverride({ role: 'hr' }), false);
  assert.equal(canUseInsuranceSelfApprovalOverride({ role: 'insurance_desk' }), false);
});

test('admin and HR roles can manage permission delegation', () => {
  for (const role of ['admin', 'mediqliq_super_admin', 'hr', 'hr_manager']) {
    assert.equal(canManageUserPermissions({ role }), true);
  }
  assert.equal(canManageUserPermissions({ role: 'accountant' }), false);
});

test('high-risk insurance actions are explicit delegations, not finance role defaults', () => {
  const delegated = new Set(DELEGABLE_INSURANCE_ACTIONS);
  for (const role of ['accountant', 'insurance_desk']) {
    const actions = roleDefaultActions(role, 'billing_finance');
    assert.equal(actions.some((action) => delegated.has(action)), false);
  }
});

test('HR default actions include user access management', () => {
  assert.equal(roleDefaultActions('hr', 'hr_staff').includes('user_access_manage'), true);
  assert.equal(roleDefaultActions('hr_manager', 'hr_staff').includes('user_access_manage'), true);
});
