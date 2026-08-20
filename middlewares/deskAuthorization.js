'use strict';

const { checkModuleAccess, _hasActionPermission, _hasUnrestrictedAdminAccess } = require('./auth');

function deny(res, message) {
  return res.status(403).json({ success: false, error: message });
}

function canViewDesk(user) {
  return _hasUnrestrictedAdminAccess(user)
    || checkModuleAccess(user, 'registration_opd', 'view')
    || checkModuleAccess(user, 'ipd', 'view')
    || checkModuleAccess(user, 'billing_finance', 'view');
}

exports.requireDeskView = (req, res, next) => {
  if (!req.user) return deny(res, 'Authentication required');
  if (!canViewDesk(req.user)) return deny(res, 'Front Desk access is not granted');
  return next();
};

exports.requireDeskPreview = (req, res, next) => {
  if (!req.user) return deny(res, 'Authentication required');
  if (!canViewDesk(req.user)) return deny(res, 'Front Desk preview access is not granted');
  return next();
};

exports.requireDeskCommit = (req, res, next) => {
  const user = req.user;
  if (!user) return deny(res, 'Authentication required');
  if (_hasUnrestrictedAdminAccess(user)) return next();

  const body = req.body || {};
  const encounterType = String(body.encounterType || 'OPD').toUpperCase();
  const action = String(body.encounterAction || 'SERVICES').toUpperCase();
  const hasRegistrationManage = checkModuleAccess(user, 'registration_opd', 'manage');
  const hasIpdManage = checkModuleAccess(user, 'ipd', 'manage');
  const hasBillingManage = checkModuleAccess(user, 'billing_finance', 'manage');

  if (body.quickPatient && !hasRegistrationManage) return deny(res, 'Patient registration permission is required');
  if ((action === 'APPOINTMENT' || encounterType === 'OPD') && !hasRegistrationManage && !hasBillingManage) {
    return deny(res, 'OPD/registration permission is required');
  }
  if ((action === 'ADMISSION' || encounterType === 'IPD') && !hasIpdManage && !hasBillingManage) {
    return deny(res, 'IPD admission permission is required');
  }
  if (body.payment?.collectNow && (!_hasActionPermission(user, 'settlement') || !hasBillingManage)) {
    return deny(res, 'Settlement permission is required to collect money');
  }
  if (body.issueInvoice !== false && !_hasActionPermission(user, 'billing_create') && !_hasActionPermission(user, 'billing_finalize')) {
    return deny(res, 'Billing permission is required to issue/post financial documents');
  }
  return next();
};
