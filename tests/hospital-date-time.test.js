'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hospitalDateKey,
  dateKeyToStorageDate,
  hospitalDayBounds,
  parseHospitalDateTime,
  calendarDayKey,
  canonicalBookingFingerprint
} = require('../utils/hospitalDateTime');

const TZ = 'Asia/Kolkata';

test('hospitalDateKey treats 18:30Z as next local date in India', () => {
  assert.equal(hospitalDateKey('2026-08-02T18:30:00.000Z', TZ), '2026-08-03');
  assert.equal(hospitalDateKey('2026-08-03T00:00:00.000Z', TZ), '2026-08-03');
});

test('date-only storage sentinel is deterministic UTC midnight', () => {
  assert.equal(dateKeyToStorageDate('2026-08-03').toISOString(), '2026-08-03T00:00:00.000Z');
});

test('hospital day bounds are local midnight-to-midnight expressed in UTC', () => {
  const bounds = hospitalDayBounds('2026-08-03', TZ);
  assert.equal(bounds.start.toISOString(), '2026-08-02T18:30:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-08-03T18:30:00.000Z');
});

test('timezone-less appointment time is interpreted as hospital wall time', () => {
  const parsed = parseHospitalDateTime('2026-08-03T14:00:00', '2026-08-03', TZ);
  assert.equal(parsed.toISOString(), '2026-08-03T08:30:00.000Z');
});

test('explicit +05:30 appointment time resolves to same canonical UTC instant', () => {
  const parsed = parseHospitalDateTime('2026-08-03T14:00:00+05:30', '2026-08-03', TZ);
  assert.equal(parsed.toISOString(), '2026-08-03T08:30:00.000Z');
});

test('explicit UTC input remains an absolute instant', () => {
  const parsed = parseHospitalDateTime('2026-08-03T14:00:00Z', '2026-08-03', TZ);
  assert.equal(parsed.toISOString(), '2026-08-03T14:00:00.000Z');
});

test('calendar day matching tolerates both legacy local-midnight and UTC-midnight storage', () => {
  assert.equal(calendarDayKey({ date: new Date('2026-08-02T18:30:00.000Z') }, TZ), '2026-08-03');
  assert.equal(calendarDayKey({ date: new Date('2026-08-03T00:00:00.000Z') }, TZ), '2026-08-03');
});

test('booking fingerprint always uses canonical UTC start time', () => {
  assert.equal(
    canonicalBookingFingerprint({
      hospitalId: 'h1', patientId: 'p1', doctorId: 'd1', appointmentDateKey: '2026-08-03',
      type: 'time-based', startTime: new Date('2026-08-03T08:30:00.000Z')
    }),
    'h1|p1|d1|2026-08-03|time-based|2026-08-03T08:30:00.000Z'
  );
});
