const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ABDM_HOSPITAL_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { encryptJson, decryptJson } = require('../services/abdmVault.service');

test('ABDM vault encrypts and authenticates JSON', () => {
  const value = { accessToken: 'sensitive', refreshToken: 'secret' };
  const encrypted = encryptJson(value, 'patient:1');
  assert.notEqual(encrypted.ciphertext.includes('sensitive'), true);
  assert.deepEqual(decryptJson(encrypted, 'patient:1'), value);
});

test('ABDM vault rejects a different associated-data context', () => {
  const encrypted = encryptJson({ value: 1 }, 'correct');
  assert.throws(() => decryptJson(encrypted, 'incorrect'));
});
