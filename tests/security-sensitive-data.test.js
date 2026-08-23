'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskAbhaNumber, maskAbhaAddress, maskAadhaar, sanitizeFreeText, cloneAndRedact } = require('../utils/sensitiveData');

test('sensitive identifiers are masked and support secrets are rejected', () => {
  assert.notEqual(maskAbhaNumber('91-1234-5678-9012'), '91-1234-5678-9012');
  assert.match(maskAbhaAddress('patient123@abdm'), /@abdm$/);
  assert.notEqual(maskAadhaar('1234 5678 9012'), '1234 5678 9012');
  const support = sanitizeFreeText('ABHA 91-1234-5678-9012 OTP: 123456', { mode: 'support' });
  assert.equal(support.rejected, true);
  assert.ok(!support.value.includes('91-1234-5678-9012'));
  assert.ok(!support.value.includes('123456'));
  const redacted = cloneAndRedact({ abhaNumber: '91-1234-5678-9012', password: 'secret', nested: 'Bearer aaa.bbb.ccc' });
  assert.ok(!JSON.stringify(redacted).includes('secret'));
  assert.ok(!JSON.stringify(redacted).includes('91-1234-5678-9012'));
});
