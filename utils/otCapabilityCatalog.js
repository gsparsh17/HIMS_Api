'use strict';

const OT_CAPABILITY_TO_ACTION = Object.freeze({
  'ot.case.view': null,
  'ot.case.create': 'ot_case_create',
  'ot.readiness.update': 'ot_readiness_update',
  'ot.schedule.manage': 'ot_schedule_manage',
  'ot.patient.receive': 'ot_patient_receive',
  'ot.safety.update': 'ot_safety_update',
  'ot.consent.admission': 'ot_consent_admission',
  'ot.consent.clinical': 'ot_consent_clinical',
  'ot.pac.edit': 'ot_pac_edit',
  'ot.anesthesia.edit': 'ot_anesthesia_edit',
  'ot.operation_note.edit': 'ot_operation_note_edit',
  'ot.inventory.manage': 'ot_inventory_manage',
  'ot.specimen.manage': 'ot_specimen_manage',
  'ot.recovery.manage': 'ot_recovery_manage',
  'ot.finance.view': 'ot_finance_view',
  'ot.finance.manage': 'ot_finance_manage',
  'ot.case.close': 'ot_case_close',
  'ot.master.manage': 'ot_master_manage',
});

const OT_SPECIAL_ACTIONS = Object.freeze([
  'ot_approve',
  'ot_emergency_bypass',
]);

const OT_ACTIONS = Object.freeze([
  ...Object.values(OT_CAPABILITY_TO_ACTION).filter(Boolean),
  ...OT_SPECIAL_ACTIONS,
]);

// Safe hospital defaults. Specialized doctor powers (PAC, anaesthesia and
// operative-note editing) are intentionally NOT granted to every doctor;
// assign those per clinician from Staff Login / role templates.
const OT_ROLE_ACTION_PRESET = Object.freeze({
  doctor: [
    'ot_case_create',
    'ot_readiness_update',
    'ot_safety_update',
    'ot_consent_clinical',
  ],
  nurse: [
    'ot_readiness_update',
    'ot_patient_receive',
    'ot_safety_update',
    'ot_consent_admission',
    'ot_inventory_manage',
    'ot_specimen_manage',
    'ot_recovery_manage',
  ],
  staff: [
    'ot_case_create',
    'ot_readiness_update',
    'ot_consent_admission',
    'ot_finance_view',
  ],
  registrar: [
    'ot_case_create',
    'ot_schedule_manage',
    'ot_consent_admission',
    'ot_finance_view',
    'ot_finance_manage',
  ],
  receptionist: [
    'ot_case_create',
    'ot_consent_admission',
    'ot_finance_view',
  ],
  ot_staff: [
    'ot_readiness_update',
    'ot_schedule_manage',
    'ot_patient_receive',
    'ot_safety_update',
    'ot_inventory_manage',
    'ot_specimen_manage',
    'ot_recovery_manage',
    'ot_case_close',
    'ot_finance_view',
  ],
});

function normalizeRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function defaultOtActionsForRole(role) {
  return Array.from(new Set(OT_ROLE_ACTION_PRESET[normalizeRole(role)] || []));
}

module.exports = {
  OT_CAPABILITY_TO_ACTION,
  OT_SPECIAL_ACTIONS,
  OT_ACTIONS,
  OT_ROLE_ACTION_PRESET,
  defaultOtActionsForRole,
};
