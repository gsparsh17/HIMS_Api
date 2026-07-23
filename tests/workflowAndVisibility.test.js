const test = require('node:test');
const assert = require('node:assert/strict');
const { LAB_TRANSITIONS, RADIOLOGY_TRANSITIONS, ensureWorkflowTransition } = require('../services/workflowDefinitions.service');
const { buildPatientFileDto } = require('../services/ipdPatientFileDto.service');
const { roleDefaultActions, defaultFeaturePermissions } = require('../utils/mainFeatureAccess');
const { stayDuration } = require('../services/accommodationMath.service');

test('laboratory lifecycle rejects invalid transitions', () => {
  assert.doesNotThrow(() => ensureWorkflowTransition('laboratory', LAB_TRANSITIONS, 'Pending', 'Approved'));
  assert.throws(() => ensureWorkflowTransition('laboratory', LAB_TRANSITIONS, 'Pending', 'Reported'), /Invalid laboratory transition/);
  assert.deepEqual(LAB_TRANSITIONS.Verified, ['Reported', 'Result Entered']);
});

test('radiology lifecycle separates scheduling, performance, verification and release', () => {
  assert.ok(RADIOLOGY_TRANSITIONS.Pending.includes('Scheduled'));
  assert.ok(RADIOLOGY_TRANSITIONS.Scheduled.includes('In Progress'));
  assert.ok(RADIOLOGY_TRANSITIONS['Result Entered'].includes('Verified'));
  assert.ok(RADIOLOGY_TRANSITIONS.Verified.includes('Reported'));
});

test('doctor and nurse DTOs never expose account balances', () => {
  const admission = { _id: 'a', totalBillAmount: 1000, paidAmount: 200, dueAmount: 800, patientReceivable: 300, sponsorReceivable: 500, wardId: {}, roomId: {}, bedId: {} };
  for (const role of ['doctor', 'nurse']) {
    const dto = buildPatientFileDto({ user: { role, modulePermissions: [] }, admission, coverage: null });
    assert.equal(dto.financialSummary, undefined);
    assert.equal(dto.admission.totalBillAmount, undefined);
    assert.equal(dto.admission.dueAmount, undefined);
  }
});

test('finance DTO separates patient and sponsor receivables', () => {
  const admission = { _id: 'a', totalBillAmount: 1000, patientReceivable: 250, sponsorReceivable: 750, dueAmount: 250 };
  const dto = buildPatientFileDto({ user: { role: 'insurance_desk' }, admission, coverage: null, charges: [{ amount: 1000 }] });
  assert.equal(dto.visibility.canViewAmounts, true);
  assert.equal(dto.financialSummary.patientReceivable, 250);
  assert.equal(dto.financialSummary.sponsorReceivable, 750);
  assert.equal(dto.financialSummary.dueAmount, 250);
});

test('least-privilege action presets assign sensitive operations only to owners', () => {
  assert.ok(roleDefaultActions('insurance_desk', 'billing_finance').includes('claim_submit'));
  assert.ok(roleDefaultActions('bed_manager', 'ipd').includes('transfer_reserve'));
  assert.equal(roleDefaultActions('doctor', 'billing_finance').includes('settlement'), false);
  assert.equal(defaultFeaturePermissions('nurse').find((row) => row.moduleKey === 'billing_finance').access, 'none');
});

test('accommodation duration is deterministic', () => {
  const value = stayDuration('2026-07-20T00:00:00.000Z', '2026-07-21T12:00:00.000Z');
  assert.equal(value.hours, 36);
  assert.equal(value.days, 1.5);
});
