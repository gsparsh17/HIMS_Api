const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalJson,
  signRequest,
  safeEqual
} = require('../utils/internalSignature');

test('canonical JSON is independent of object key insertion order', () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 })
  );
});

test('connector signature changes when the body changes', () => {
  const input = {
    timestamp: '2026-07-24T00:00:00.000Z',
    requestId: 'request-1',
    method: 'POST',
    path: '/internal/abdm/discover'
  };
  const first = signRequest('a-secure-connector-secret', {
    ...input,
    body: { patient: { id: 'one@sbx' } }
  });
  const second = signRequest('a-secure-connector-secret', {
    ...input,
    body: { patient: { id: 'two@sbx' } }
  });
  assert.equal(safeEqual(first, first), true);
  assert.equal(safeEqual(first, second), false);
});
