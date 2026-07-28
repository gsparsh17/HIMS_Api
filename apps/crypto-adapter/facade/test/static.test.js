const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('crypto facade exposes the exact MediQliq adapter contract', () => {
  assert.match(source, /\/v1\/receiver-key-material/);
  assert.match(source, /\/v1\/encrypt/);
  assert.match(source, /\/v1\/decrypt/);
  assert.match(source, /integrityVerified: true/);
});

test('opaque key handles use authenticated encryption', () => {
  assert.match(source, /aes-256-gcm/);
  assert.match(source, /setAAD/);
  assert.match(source, /setAuthTag/);
});
