const ROLE_CAPABILITIES = Object.freeze({
  'ot.case.view': ['admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'ot_staff', 'store_manager', 'inventory_manager', 'accountant', 'registrar'],
  'ot.case.create': ['admin', 'mediqliq_super_admin', 'doctor', 'staff', 'registrar'],
  'ot.readiness.update': ['admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'ot_staff'],
  'ot.schedule.manage': ['admin', 'mediqliq_super_admin', 'ot_staff', 'staff', 'registrar'],
  'ot.patient.receive': ['admin', 'mediqliq_super_admin', 'ot_staff', 'nurse'],
  'ot.safety.update': ['admin', 'mediqliq_super_admin', 'ot_staff', 'nurse', 'doctor'],
  'ot.consent.admission': ['admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar'],
  'ot.consent.clinical': ['admin', 'mediqliq_super_admin', 'doctor'],
  'ot.pac.edit': ['admin', 'mediqliq_super_admin', 'doctor'],
  'ot.anesthesia.edit': ['admin', 'mediqliq_super_admin', 'doctor'],
  'ot.operation_note.edit': ['admin', 'mediqliq_super_admin', 'doctor'],
  'ot.inventory.manage': ['admin', 'mediqliq_super_admin', 'ot_staff', 'nurse', 'inventory_manager', 'store_manager'],
  'ot.specimen.manage': ['admin', 'mediqliq_super_admin', 'ot_staff', 'nurse', 'doctor'],
  'ot.recovery.manage': ['admin', 'mediqliq_super_admin', 'ot_staff', 'nurse', 'doctor'],
  'ot.finance.view': ['admin', 'mediqliq_super_admin', 'doctor', 'staff', 'accountant', 'registrar', 'ot_staff'],
  'ot.finance.manage': ['admin', 'mediqliq_super_admin', 'accountant', 'registrar', 'staff'],
  'ot.case.close': ['admin', 'mediqliq_super_admin', 'ot_staff', 'doctor'],
  'ot.master.manage': ['admin', 'mediqliq_super_admin'],
});

function roleOf(user) {
  return String(user?.role || '').trim().toLowerCase();
}

function can(user, capability) {
  const allowed = ROLE_CAPABILITIES[capability] || [];
  return allowed.includes(roleOf(user));
}

function requireOtCapability(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'User not authenticated' });
    if (can(req.user, capability)) return next();
    return res.status(403).json({
      success: false,
      error: `OT capability "${capability}" is not permitted for this user`,
      capability,
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

module.exports = { ROLE_CAPABILITIES, TRANSITION_CAPABILITY, can, requireOtCapability, requireOtTransitionCapability };
