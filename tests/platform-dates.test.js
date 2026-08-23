const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOptionalDate, parseDateOrNow } = require('../utils/platformDates');

test('platform date parser accepts ISO dates and missing optional dates', () => {
  assert.equal(parseOptionalDate(undefined, 'license.startsAt'), undefined);
  assert.equal(
    parseOptionalDate('2026-08-23T07:11:14.283Z', 'license.startsAt').toISOString(),
    '2026-08-23T07:11:14.283Z'
  );
});

test('platform date parser rejects malformed dates with a stable error code', () => {
  assert.throws(
    () => parseOptionalDate({}, 'license.updatedAt'),
    (error) => error.code === 'INVALID_PLATFORM_DATE' && error.statusCode === 400
  );
});

test('platform date parser falls back to now only when the field is absent', () => {
  const before = Date.now();
  const value = parseDateOrNow(undefined, 'license.updatedAt');
  const after = Date.now();
  assert.ok(value.getTime() >= before && value.getTime() <= after);
});
