'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  generateTotpSecret,
  totpCode,
  verifyTotp,
  passwordPolicyErrors,
  verifySsoAssertion
} = require('../services/nabhSecurity.service');

test('TOTP codes are six digits and validate only for the configured secret/window', () => {
  const secret = generateTotpSecret();
  const otherSecret = generateTotpSecret();
  const timestamp = 1_725_000_000_000;
  const code = totpCode(secret, timestamp);

  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, { timestamp, window: 0 }), true);
  assert.equal(verifyTotp(otherSecret, code, { timestamp, window: 0 }), false);
  assert.equal(verifyTotp(secret, 'invalid', { timestamp, window: 0 }), false);
});

test('password policy enforces the configured complexity rules', () => {
  assert.deepEqual(passwordPolicyErrors('StrongPass1!'), []);
  const failures = passwordPolicyErrors('weak');
  assert.ok(failures.some((message) => message.includes('Minimum')));
  assert.ok(failures.some((message) => message.includes('uppercase')));
  assert.ok(failures.some((message) => message.includes('number')));
  assert.ok(failures.some((message) => message.includes('special')));
});

test('SSO assertion validation rejects tampering', () => {
  const assertionSecret = 'unit-test-secret';
  const timestamp = new Date().toISOString();
  const assertion = {
    email: 'user@example.com',
    issuer: 'hospital-idp',
    audience: 'mediqliq-hims',
    timestamp
  };
  const payload = `${assertion.email}|${assertion.issuer}|${assertion.audience}|${timestamp}`;
  assertion.signature = crypto.createHmac('sha256', assertionSecret).update(payload).digest('hex');
  const settings = {
    security: {
      sso: {
        assertionSecret,
        issuer: assertion.issuer,
        audience: assertion.audience
      }
    }
  };

  assert.equal(verifySsoAssertion(assertion, settings).valid, true);
  assert.equal(
    verifySsoAssertion({ ...assertion, email: 'attacker@example.com' }, settings).valid,
    false
  );
});
