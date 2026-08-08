'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coverage = require('../config/nabhCoverage');

const NABH_DOMAINS = new Set(['AAC', 'COP', 'MOM', 'DAC', 'DOM', 'FPM', 'HRM', 'IMS']);

test('NABH implementation catalogue contains all 158 software-addressable test cases once', () => {
  assert.equal(coverage.length, 158);
  const ids = coverage.map((item) => item.testCaseId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(coverage.every((item) => item.testCaseId && item.testCase && item.objective));
  assert.ok(coverage.every((item) => NABH_DOMAINS.has(item.domain)));
});
