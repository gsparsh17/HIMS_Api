'use strict';

const User = require('../models/User');
const { mainFeaturePermission, ACCESS_ORDER } = require('../utils/mainFeatureAccess');
const { getSnapshot } = require('./licenseSnapshot.service');
const { isEntitled } = require('../utils/entitlements');
const { _hasActionPermission: hasActionPermission } = require('../middlewares/auth');

async function authorizeDelegatedJob({ userId, hospitalId, moduleKey = 'reports', minimumAccess = 'view', action }) {
  const user = await User.findById(userId).select('role hospital_id is_active modulePermissions enforceModulePermissions securityVersion privilegedActions');
  if (!user || !user.is_active) {
    const error = new Error('The user who created this scheduled job is no longer active');
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  if (String(user.hospital_id || '') !== String(hospitalId || '')) {
    const error = new Error('Scheduled job hospital ownership no longer matches its creator');
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  const { snapshot } = await getSnapshot(hospitalId);
  if (!snapshot || !['active', 'expiring', 'ACTIVE', 'EXPIRING'].includes(String(snapshot.status))) {
    const error = new Error('Hospital license is not active for scheduled job execution');
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  if (!isEntitled(snapshot.effectiveEntitlements || {}, moduleKey)) {
    const error = new Error(`Hospital is no longer entitled to ${moduleKey}`);
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  const permission = mainFeaturePermission(user, moduleKey);
  if (ACCESS_ORDER[permission.access] < ACCESS_ORDER[minimumAccess]) {
    const error = new Error(`Creator no longer has ${minimumAccess} access to ${moduleKey}`);
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  if (action && !hasActionPermission(user, action)) {
    const error = new Error(`Creator no longer has ${action} permission`);
    error.code = 'AUTHORIZATION_REVOKED';
    throw error;
  }
  return user;
}

function authorizationSnapshot(user, { moduleKey = 'reports', action } = {}) {
  return {
    userId: String(user?._id || ''),
    role: user?.role,
    securityVersion: Number(user?.securityVersion || 0),
    moduleKey,
    action: action || null,
    capturedAt: new Date()
  };
}

module.exports = { authorizeDelegatedJob, authorizationSnapshot };
