const test = require('node:test');
const assert = require('node:assert/strict');

const {
  blockedInterval,
  intervalsOverlap,
  teamAssignments,
  staffAvailabilityConflicts
} = require('../services/otScheduling.service');
const { allowedActions, buildTransitionDefinitions } = require('../services/otWorkflow.service');

test('OT room block includes setup and cleaning buffers', () => {
  const start = new Date('2026-09-15T10:00:00.000Z');
  const end = new Date('2026-09-15T11:00:00.000Z');
  const block = blockedInterval({ scheduledStart: start, scheduledEnd: end, setupBufferMinutes: 15, cleaningBufferMinutes: 20 });
  assert.equal(block.blockedStart.toISOString(), '2026-09-15T09:45:00.000Z');
  assert.equal(block.blockedEnd.toISOString(), '2026-09-15T11:20:00.000Z');
  assert.equal(intervalsOverlap(block.blockedStart, block.blockedEnd, new Date('2026-09-15T11:10:00.000Z'), new Date('2026-09-15T12:00:00.000Z')), true);
  assert.equal(intervalsOverlap(block.blockedStart, block.blockedEnd, new Date('2026-09-15T11:20:00.000Z'), new Date('2026-09-15T12:00:00.000Z')), false);
});

test('OT team assignment normalizes clinical resource roles', () => {
  const rows = teamAssignments({ primarySurgeonId: 'a', anesthetistId: 'b', scrubNurseId: 'c', otStaffId: 'd' });
  assert.deepEqual(rows.map((row) => [row.kind, row.role, row.id]), [
    ['doctor', 'Primary Surgeon', 'a'],
    ['doctor', 'Anaesthetist', 'b'],
    ['nurse', 'Scrub Nurse', 'c'],
    ['otstaff', 'OT Roster Staff', 'd']
  ]);
});

test('OT staff unavailable ranges are treated as scheduling conflicts', () => {
  const interval = blockedInterval({ scheduledStart: '2026-09-15T10:00:00.000Z', scheduledEnd: '2026-09-15T11:00:00.000Z' });
  const conflicts = staffAvailabilityConflicts({
    _id: 'staff1', designation: 'OT Technician', shiftAvailability: [],
    unavailableRanges: [{ from: new Date('2026-09-15T09:00:00.000Z'), to: new Date('2026-09-15T12:00:00.000Z'), reason: 'Leave' }]
  }, interval, 'UTC');
  assert.equal(conflicts[0].type, 'STAFF_UNAVAILABLE');
  assert.equal(conflicts[0].reason, 'Leave');
});

test('workspace allowed actions enforce safety gates', () => {
  const base = { status: 'Patient Received', readinessStatus: 'Ready', financialClearanceState: 'CLEARED' };
  assert.equal(allowedActions(base, { safety: { signIn: { status: 'Pending' }, timeOut: { status: 'Pending' }, signOut: { status: 'Pending' } } }).start, false);
  assert.equal(allowedActions(base, { safety: { signIn: { status: 'Completed' }, timeOut: { status: 'Pending' }, signOut: { status: 'Pending' } } }).start, true);
  const operating = { ...base, status: 'In Progress' };
  assert.equal(allowedActions(operating, { safety: { signIn: { status: 'Completed' }, timeOut: { status: 'Completed' }, signOut: { status: 'Pending' } } }).recover, false);
  assert.equal(allowedActions(operating, { safety: { signIn: { status: 'Completed' }, timeOut: { status: 'Completed' }, signOut: { status: 'Bypassed' } } }).recover, true);
});

test('patient receipt transition requires all receiving confirmations', async () => {
  const definitions = buildTransitionDefinitions({
    receiptGuard: (_doc, req) => ['identityConfirmed', 'procedureConfirmed', 'siteConfirmed', 'handoverReceived'].every((key) => req.body[key] === true) || 'receipt incomplete'
  });
  const ok = await definitions.receive.guard(
    { readinessStatus: 'Ready', financialClearanceState: 'CLEARED' },
    { body: { identityConfirmed: true, procedureConfirmed: true, siteConfirmed: true, handoverReceived: true } }
  );
  const bad = await definitions.receive.guard(
    { readinessStatus: 'Ready', financialClearanceState: 'CLEARED' },
    { body: { identityConfirmed: true } }
  );
  assert.equal(ok, true);
  assert.equal(bad, 'receipt incomplete');
});
