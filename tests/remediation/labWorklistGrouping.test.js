'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupLabRequests, aggregateStatus } = require('../../services/labWorklistGrouping.service');

test('patient/request worklist groups multiple tests from one prescription into one primary row', () => {
  const base = {
    patientId: { _id: 'patient-1', first_name: 'Rakesh', last_name: 'Sharma' },
    doctorId: { _id: 'doctor-1' },
    orderGroupId: 'rx-1',
    orderNumber: 'RX-2026-001',
    requestGroupKey: 'RX:rx-1',
    requestedDate: '2026-08-15T07:30:00.000Z',
    sourceType: 'OPD',
    priority: 'Urgent'
  };
  const names = ['HBsAg', 'HIV', 'Blood Group', 'PT/INR', 'Blood Glucose', 'Potassium', 'Sodium', 'CBC'];
  const rows = names.map((name, i) => ({
    ...base,
    _id: `request-${i + 1}`,
    requestNumber: `LAB-${String(i + 1).padStart(3, '0')}`,
    testName: name,
    status: 'Reported'
  }));

  const grouped = groupLabRequests(rows);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].testCount, 8);
  assert.equal(grouped[0].tests.length, 8);
  assert.equal(grouped[0].status, 'Reported');
  assert.equal(grouped[0].groupId, 'RX:rx-1');
});

test('aggregateStatus exposes the most useful workflow stage for a mixed request', () => {
  assert.equal(aggregateStatus([{ status: 'Pending' }, { status: 'Sample Collected' }]), 'Sample Collected');
  assert.equal(aggregateStatus([{ status: 'Verified' }, { status: 'Reported' }]), 'Verified');
  assert.equal(aggregateStatus([{ status: 'Reported' }, { status: 'Reported' }]), 'Reported');
});
