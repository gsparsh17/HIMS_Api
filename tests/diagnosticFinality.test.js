const test = require('node:test');
const assert = require('node:assert/strict');
const { isFinalLabRequest, isFinalRadiologyRequest } = require('../services/diagnosticFinality.service');

test('explicit report finalisation marker is authoritative', () => {
  assert.equal(isFinalLabRequest({ status: 'Verified', reportFinalisation: { isFinal: false } }), false);
  assert.equal(isFinalLabRequest({ status: 'Reported', reportFinalisation: { isFinal: false } }), false);
  assert.equal(isFinalLabRequest({ status: 'Verified', reportFinalisation: { isFinal: true } }), true);

  assert.equal(isFinalRadiologyRequest({ status: 'Verified', reportFinalisation: { isFinal: false } }), false);
  assert.equal(isFinalRadiologyRequest({ status: 'Amended', reportFinalisation: { isFinal: false } }), false);
  assert.equal(isFinalRadiologyRequest({ status: 'Reported', reportFinalisation: { isFinal: true } }), true);
});

test('legacy fallback accepts only released/reported diagnostic records', () => {
  assert.equal(isFinalLabRequest({ status: 'Reported' }), true);
  assert.equal(isFinalLabRequest({ status: 'Released' }), true);
  assert.equal(isFinalLabRequest({ status: 'Verified' }), false);
  assert.equal(isFinalLabRequest({ status: 'Completed' }), false);
  assert.equal(isFinalLabRequest({ status: 'Amended' }), false);

  assert.equal(isFinalRadiologyRequest({ status: 'Reported' }), true);
  assert.equal(isFinalRadiologyRequest({ status: 'Verified' }), false);
  assert.equal(isFinalRadiologyRequest({ status: 'Completed' }), false);
  assert.equal(isFinalRadiologyRequest({ status: 'Amended' }), false);
});
