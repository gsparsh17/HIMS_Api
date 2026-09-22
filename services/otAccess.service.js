'use strict';

const { mainFeaturePermission, effectiveMainFeaturePermissions } = require('../utils/mainFeatureAccess');
const { getTemplate } = require('../config/otSurgeryFormTemplates');
const { OT_CAPABILITY_TO_ACTION } = require('../utils/otCapabilityCatalog');

function normalizedRole(user) {
  return String(user?.role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function unrestricted(user) {
  const role = normalizedRole(user);
  return role === 'mediqliq_super_admin' || (role === 'admin' && !user?.enforceModulePermissions);
}

function hasAction(user, action) {
  if (unrestricted(user)) return true;
  return effectiveMainFeaturePermissions(user).some((permission) =>
    Array.isArray(permission.actions) && permission.actions.includes(action)
  );
}

function can(user, capability) {
  if (!user) return false;
  if (unrestricted(user)) return true;
  const moduleAccess = mainFeaturePermission(user, 'operation_theatre').access;
  if (!['view', 'manage'].includes(moduleAccess)) return false;
  if (capability === 'ot.case.view') return true;

  // Ordinary hospital operating model: operation_theatre.manage is an umbrella
  // permission for the full clinical OT lifecycle. Fine-grained OT actions are
  // still honoured for view-only/custom roles. Money collection is deliberately
  // separate and follows billing_finance.manage.
  if (capability === 'ot.finance.manage') {
    return mainFeaturePermission(user, 'billing_finance').access === 'manage';
  }
  if (capability === 'ot.finance.view') {
    return moduleAccess === 'manage' || ['view', 'manage'].includes(mainFeaturePermission(user, 'billing_finance').access);
  }
  if (moduleAccess === 'manage') return true;

  const action = OT_CAPABILITY_TO_ACTION[capability];
  if (!action) return false;
  return hasAction(user, action);
}

function requireOtCapability(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'User not authenticated' });
    if (can(req.user, capability)) return next();
    return res.status(403).json({
      success: false,
      error: `OT capability "${capability}" is not permitted for this user`,
      capability,
      requiredAction: OT_CAPABILITY_TO_ACTION[capability] || null,
    });
  };
}

const TRANSITION_CAPABILITY = Object.freeze({
  approve: 'ot.readiness.update',
  receive: 'ot.patient.receive',
  start: 'ot.safety.update',
  recover: 'ot.safety.update',
  transfer: 'ot.recovery.manage',
  close: 'ot.case.close',
  postpone: 'ot.schedule.manage',
  cancel: 'ot.schedule.manage',
});

function requireOtTransitionCapability(req, res, next) {
  const action = String(req.body?.action || '').trim().toLowerCase();
  const capability = TRANSITION_CAPABILITY[action] || 'ot.case.view';
  return requireOtCapability(capability)(req, res, next);
}


const LEGACY_STATUS_CAPABILITY = Object.freeze({
  approved: 'ot.readiness.update',
  scheduled: 'ot.schedule.manage',
  'patient received': 'ot.patient.receive',
  'in progress': 'ot.safety.update',
  recovery: 'ot.safety.update',
  transferred: 'ot.recovery.manage',
  completed: 'ot.case.close',
  closed: 'ot.case.close',
  postponed: 'ot.schedule.manage',
  cancelled: 'ot.schedule.manage',
});

function requireOtLegacyStatusCapability(req, res, next) {
  const status = String(req.body?.status || req.body?.newStatus || '').trim().toLowerCase();
  const capability = LEGACY_STATUS_CAPABILITY[status] || 'ot.case.view';
  return requireOtCapability(capability)(req, res, next);
}

function capabilityForFormTemplate(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return 'ot.readiness.update';
  const template = getTemplate(id);
  if (!template) return 'ot.readiness.update';

  if (id === 'general_consent') return 'ot.consent.admission';
  if (template.category === 'consent') return 'ot.consent.clinical';
  if (id === 'pre_anaesthesia_assessment' || id === 'pac-record') return 'ot.pac.edit';
  if (id === 'intra_post_anaesthesia_record' || id === 'anesthesia_monitoring_chart') return 'ot.anesthesia.edit';
  if (id === 'operation_notes' || id === 'operation-record') return 'ot.operation_note.edit';
  if (id === 'post_anaesthesia_recovery_record') return 'ot.recovery.manage';
  if (id === 'ot_consumables_implants' || id === 'implant_device_register') return 'ot.inventory.manage';
  if (id === 'surgical_specimen_handover') return 'ot.specimen.manage';

  switch (template.sourceModel) {
    case 'OTReadinessChecklist': return 'ot.readiness.update';
    case 'OTSurgicalSafetyChecklist': return 'ot.safety.update';
    case 'OTPreAnaesthesiaAssessment': return 'ot.pac.edit';
    case 'OTAnesthesiaRecord': return 'ot.anesthesia.edit';
    case 'OTOperativeNote': return 'ot.operation_note.edit';
    case 'OTRecoveryRecord': return 'ot.recovery.manage';
    case 'OTCaseInventoryUsage': return 'ot.inventory.manage';
    default: break;
  }

  if (template.category === 'anesthesia') return 'ot.anesthesia.edit';
  if (template.category === 'recovery') return 'ot.recovery.manage';
  if (template.stage === 'intraop') return 'ot.operation_note.edit';
  return 'ot.readiness.update';
}

function requireOtFormCapability(req, res, next) {
  const capability = capabilityForFormTemplate(req.params?.templateId);
  return requireOtCapability(capability)(req, res, next);
}

module.exports = {
  CAPABILITY_TO_ACTION: OT_CAPABILITY_TO_ACTION,
  TRANSITION_CAPABILITY,
  LEGACY_STATUS_CAPABILITY,
  can,
  requireOtCapability,
  requireOtTransitionCapability,
  requireOtLegacyStatusCapability,
  capabilityForFormTemplate,
  requireOtFormCapability,
};
