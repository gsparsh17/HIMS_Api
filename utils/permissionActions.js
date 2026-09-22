'use strict';

const { OT_ACTIONS } = require('./otCapabilityCatalog');

const PERMISSION_ACTIONS = Object.freeze([
  'approve',
  'discount_override',
  'refund',
  'settlement',
  'final_clearance',
  'bulk_import_commit',
  'user_access_manage',
  ...OT_ACTIONS,
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
  'billing_delete_issued_document',
  'billing_apply_discount',
  'billing_finalize',
  'billing_mode_override',
  'tax_override',
  'ipd_admission_manage',
  'ipd_round_write',
  'ipd_clinical_write',
  'ipd_nursing_write',
  'ipd_medication_write',
  'ipd_discharge_write',
  'ipd_discharge_support',
  'ipd_discharge_override',
  'ipd_final_discharge',
  'pharmacy_finance_access',
  'appointment_complete'
]);

const PERMISSION_ACTION_SET = new Set(PERMISSION_ACTIONS);

module.exports = {
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_SET
};
