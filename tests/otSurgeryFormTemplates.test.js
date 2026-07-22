const test = require('node:test');
const assert = require('node:assert/strict');
const { templates, getTemplate } = require('../config/otSurgeryFormTemplates');

const requiredTemplateIds = [
  'general_consent',
  'communicable_disease_testing_consent',
  'high_risk_consent',
  'surgery_procedure_consent',
  'anesthesia_consent',
  'blood_transfusion_consent',
  'patient_history_physical_examination',
  'pre_op_safety_checklist',
  'surgical_safety_checklist',
  'checklist_verification_pre_post_op',
  'pre_anaesthesia_assessment',
  'intra_post_anaesthesia_record',
  'operation_notes',
  'surgeon_postoperative_orders',
  'post_anaesthesia_recovery_record',
  'anesthesia_monitoring_chart',
  'ot_handover_sheet',
  'post_op_monitoring_chart',
  'blood_transfusion_adverse_effect',
  'investigation_chart',
  'critical_care_flow_chart',
  'icu_nursing_sheet',
  'intake_output_chart',
  'implant_device_register',
  'surgical_specimen_handover',
  'ot_readiness',
  'ot_consumables_implants',
];

const exactReferenceForms = {
  pre_op_safety_checklist: { rendererId: 'pre-op-safety-checklist', pages: 1, roles: ['surgeon', 'staff_nurse', 'anaesthetist'] },
  surgical_safety_checklist: { rendererId: 'surgical-safety-checklist', pages: 1, roles: ['anaesthetist', 'surgeon', 'scrub_nurse'] },
  checklist_verification_pre_post_op: { rendererId: 'pre-post-op-verification', pages: 2, roles: ['ward_nurse', 'surgeon', 'ot_staff', 'receiving_nurse'] },
  intra_post_anaesthesia_record: { rendererId: 'intra-post-anesthesia-record', pages: 2, roles: ['anaesthetist'] },
  operation_notes: { rendererId: 'operation-record', pages: 2, roles: ['surgeon'] },
  pre_anaesthesia_assessment: { rendererId: 'pac-record', pages: 2, roles: ['anaesthetist'] },
  post_anaesthesia_recovery_record: { rendererId: 'post-anesthesia-instructions', pages: 1, roles: ['anaesthetist'] },
};

test('surgery form registry contains the complete required surgical packet', () => {
  const ids = new Set(templates.map((template) => template.id));
  requiredTemplateIds.forEach((id) => assert.equal(ids.has(id), true, `Missing ${id}`));
  assert.equal(ids.size, templates.length, 'Template IDs must be unique');
});

test('structured surgery forms have editable sections and fields', () => {
  templates.filter((template) => template.implementation === 'structured').forEach((template) => {
    assert.ok(Array.isArray(template.sections) && template.sections.length > 0, `${template.id} requires sections`);
    assert.ok(template.sections.every((section) => Array.isArray(section.fields) && section.fields.length > 0), `${template.id} requires fields`);
    assert.ok(Array.isArray(template.referencePages) && template.referencePages.length > 0, `${template.id} requires reference-page traceability`);
  });
});

test('native forms point to dedicated OT modules', () => {
  templates.filter((template) => template.implementation === 'native').forEach((template) => {
    assert.ok(template.nativeTab, `${template.id} requires nativeTab`);
    assert.ok(template.sourceModel, `${template.id} requires sourceModel`);
    assert.equal(getTemplate(template.id)?.id, template.id);
  });
});

test('all supplied OT reference forms have exact print renderers, page counts and signature roles', () => {
  Object.entries(exactReferenceForms).forEach(([id, expected]) => {
    const template = getTemplate(id);
    assert.ok(template, `Missing exact reference form ${id}`);
    assert.equal(template.implementation, 'structured');
    assert.equal(template.rendererId, expected.rendererId);
    assert.equal(template.pageCount, expected.pages);
    assert.deepEqual(template.signatureRoles, expected.roles);
    assert.ok(template.sourceReference, `${id} requires source traceability`);
  });
});
