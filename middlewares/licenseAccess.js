const { activeSnapshot, assertEntitlement } = require('../services/licenseSnapshot.service');

const EXEMPT_PREFIXES = [
  '/support-tickets',
  '/license/status',
  '/license/refresh'
];

const ROUTE_ENTITLEMENTS = [
  ['/clinical-ai', 'clinical_ai'],
  ['/setup-assistant', 'masters_settings'],
  ['/abha', 'abdm'],
  ['/abdm', 'abdm'],
  ['/pharmacy', 'pharmacy'],
  ['/medicines', 'pharmacy'],
  ['/batches', 'pharmacy'],
  ['/stock-adjustments', 'pharmacy'],
  ['/orders', 'pharmacy'],
  ['/customers', 'pharmacy'],
  ['/suppliers', 'pharmacy'],
  ['/pharmacy-bills', 'pharmacy'],
  ['/lab', 'laboratory'],
  ['/labtests', 'laboratory'],
  ['/labreports', 'laboratory'],
  ['/pathology-staff', 'laboratory'],
  ['/external-lab', 'laboratory'],
  ['/radiology', 'radiology'],
  ['/ot', 'operation_theatre'],
  ['/procedurerequests', 'operation_theatre'],
  ['/procedures', 'operation_theatre'],
  ['/store', 'store_inventory'],
  ['/hr/dashboard', 'hr_staff'],
  ['/hr/attendance', 'hr_staff'],
  ['/hr/availability', 'hr_staff'],
  ['/hr/leaves', 'hr_staff'],
  ['/hr/leave-balances', 'hr_staff'],
  ['/hr/payrolls', 'hr_staff'],
  ['/hr/appraisals', 'hr_staff'],
  ['/hr/workflow-rules', 'hr_staff'],
  ['/hr/inductions', 'hr_staff'],
  ['/hr/training', 'hr_staff'],
  ['/hr/sync-profiles', 'hr_staff'],
  ['/biometric', 'hr_staff'],
  ['/salaries', 'hr_staff'],
  ['/billing', 'billing_finance'],
  ['/payments', 'billing_finance'],
  ['/expenses', 'billing_finance'],
  ['/revenue', 'billing_finance'],
  ['/finance', 'billing_finance'],
  ['/billing-documents', 'billing_finance'],
  ['/financial-communications', 'billing_finance'],
  ['/source-finance', 'billing_finance'],
  ['/invoices', 'billing_finance'],
  ['/insurance-providers', 'insurance_tpa'],
  ['/portability', 'insurance_tpa'],
  ['/claims', 'insurance_tpa'],
  ['/coverage', 'insurance_tpa'],
  ['/repricing', 'insurance_tpa'],
  ['/tariff', 'insurance_tpa'],
  ['/ipd', 'ipd'],
  ['/wards', 'ipd'],
  ['/admission-workflows', 'ipd'],
  ['/clinical-assessments', 'ipd'],
  ['/clinical-order-sets', 'ipd'],
  ['/blood-bank', 'ipd'],
  ['/safety', 'nabh'],
  ['/emergency-care', 'ipd'],
  ['/patient-experience', 'registration_opd'],
  ['/patients', 'registration_opd'],
  ['/appointments', 'registration_opd'],
  ['/doctors', 'registration_opd'],
  ['/nurses', 'ipd'],
  ['/staff', 'registration_opd'],
  ['/prescriptions', 'registration_opd'],
  ['/mis', 'advanced_mis'],
  ['/mrd', 'reports'],
  ['/audit-logs', 'reports'],
  // Financial/discharge policy is a core hospital setting even when the NABH
  // product entitlement is not enabled. Keep the rest of /nabh gated normally.
  ['/nabh/settings', 'masters_settings'],
  ['/nabh', 'nabh'],
  ['/operational-settings', 'masters_settings'],
  ['/admin/backups', 'masters_settings'],
  ['/admin/config', 'masters_settings'],
  ['/imports', 'masters_settings'],
  ['/departments', 'masters_settings'],
  ['/rooms', 'masters_settings'],
  ['/shifts', 'masters_settings'],
  ['/hospital-charges', 'masters_settings'],
  ['/approvals', 'masters_settings'],
  ['/print-identities', 'masters_settings']
];

function requestHospitalId(req) {
  return req.user?.hospital_id || req.user?.hospitalId || req.user?.hospitalID;
}

function exempt(req) {
  const path = String(req.path || req.originalUrl || '');
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function requireActiveLicense(req, res, next) {
  if (exempt(req)) return next();
  try {
    const snapshot = await activeSnapshot(requestHospitalId(req), { refreshIfDue: true });
    req.licenseSnapshot = snapshot;
    req.entitlements = snapshot.effectiveEntitlements || {};
    return next();
  } catch (error) {
    return res.status(error.statusCode || 403).json({
      success: false,
      code: error.code || 'LICENSE_INACTIVE',
      message: error.message,
      expiresAt: error.expiresAt
    });
  }
}

function entitlementForRequest(req) {
  const path = String(req.path || req.originalUrl || '').replace(/^\/api/, '');
  const match = ROUTE_ENTITLEMENTS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix));
  return match?.[1] || null;
}

async function requireRouteEntitlement(req, res, next) {
  if (exempt(req)) return next();
  const entitlement = entitlementForRequest(req);
  if (!entitlement) return next();
  try {
    const snapshot = req.licenseSnapshot || await assertEntitlement(requestHospitalId(req), entitlement);
    const entitlements = snapshot.effectiveEntitlements || {};
    if (!entitlements[entitlement]) {
      return res.status(403).json({ success: false, code: 'ENTITLEMENT_REQUIRED', entitlement, message: `The ${entitlement.replace(/_/g, ' ')} feature is not included in this hospital's MediQliq plan.` });
    }
    return next();
  } catch (error) {
    return res.status(error.statusCode || 403).json({ success: false, code: error.code || 'ENTITLEMENT_REQUIRED', entitlement: error.entitlement || entitlement, message: error.message });
  }
}

function requireEntitlement(entitlement) {
  return async (req, res, next) => {
    try {
      await assertEntitlement(requestHospitalId(req), entitlement);
      return next();
    } catch (error) {
      return res.status(error.statusCode || 403).json({ success: false, code: error.code || 'ENTITLEMENT_REQUIRED', entitlement, message: error.message });
    }
  };
}

module.exports = { requireActiveLicense, requireRouteEntitlement, requireEntitlement, ROUTE_ENTITLEMENTS };
