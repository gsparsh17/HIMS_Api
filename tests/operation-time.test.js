'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  operationNow,
  operationDateKey,
  isBackdatedOperation,
  runWithOperationTime,
  parseEffectiveHeader
} = require('../utils/operationTimeContext');

test('operation clock defaults to real time when no request context exists', () => {
  const before = Date.now();
  const value = operationNow().getTime();
  const after = Date.now();
  assert.ok(value >= before && value <= after);
  assert.equal(isBackdatedOperation(), false);
});

test('operation clock is request-scoped and preserves hospital date', async () => {
  const effectiveAt = new Date('2026-07-15T05:00:00.000Z'); // 10:30 Asia/Kolkata
  await runWithOperationTime({
    effectiveAt,
    actualRequestAt: new Date('2026-08-19T06:30:00.000Z'),
    timeZone: 'Asia/Kolkata',
    overridden: true,
    source: 'DATE_SETTER'
  }, async () => {
    await Promise.resolve();
    assert.equal(operationNow().toISOString(), effectiveAt.toISOString());
    assert.equal(operationDateKey(), '2026-07-15');
    assert.equal(isBackdatedOperation(), true);
  });
});

test('effective header accepts historical UTC instant', () => {
  const parsed = parseEffectiveHeader('2026-07-15T05:00:00.000Z', 'Asia/Kolkata');
  assert.equal(parsed.toISOString(), '2026-07-15T05:00:00.000Z');
});
