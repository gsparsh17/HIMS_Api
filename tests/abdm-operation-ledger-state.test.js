'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const modelPath = require.resolve('../models/AbdmOperationLedger');
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: {} };
const {
  beforeExternal,
  externalAccepted,
  externalFailed,
  localCommitted,
  completeOperation,
  requireReconciliation,
  assertSafeIdempotentReplay
} = require('../services/abdmOperationLedger.service');

function fake(status = 'CREATED') {
  return {
    status,
    attempts: 0,
    resultRef: {},
    reconciliation: {},
    async save() { this.saved = (this.saved || 0) + 1; return this; }
  };
}

test('ABDM operation ledger stage transitions are durable and ordered', async () => {
  const op = fake();
  await beforeExternal(op);
  assert.equal(op.status, 'SENT');
  assert.equal(op.attempts, 1);
  assert.ok(op.lastAttemptAt instanceof Date);

  await externalAccepted(op, { txnId: 'txn-1', message: 'ok' });
  assert.equal(op.status, 'EXTERNAL_ACCEPTED');
  assert.equal(op.externalTxnId, 'txn-1');
  assert.ok(op.externalAcceptedAt instanceof Date);
  assert.ok(op.externalResponseFingerprint);

  await localCommitted(op, { patientId: 'p1' });
  assert.equal(op.status, 'LOCAL_COMMITTED');
  assert.equal(op.resultRef.patientId, 'p1');

  await completeOperation(op, { committed: true });
  assert.equal(op.status, 'COMPLETED');
  assert.equal(op.resultRef.committed, true);
  assert.equal(op.reconciliation.resolution, 'COMPLETED');
});

test('transport/server failures are ambiguous, 4xx rejects are definitive', async () => {
  const ambiguous = fake('SENT');
  await externalFailed(ambiguous, Object.assign(new Error('timeout'), { statusCode: 503, code: 'UPSTREAM_TIMEOUT' }));
  assert.equal(ambiguous.status, 'UNKNOWN');
  assert.match(ambiguous.reconciliation.reason, /ambiguous/i);

  const rejected = fake('SENT');
  await externalFailed(rejected, Object.assign(new Error('bad request'), { statusCode: 400 }));
  assert.equal(rejected.status, 'FAILED');
});

test('external success followed by local failure requires explicit reconciliation', async () => {
  const op = fake('EXTERNAL_ACCEPTED');
  await requireReconciliation(op, 'external accepted but local commit failed', new Error('db unavailable'));
  assert.equal(op.status, 'RECONCILIATION_REQUIRED');
  assert.match(op.reconciliation.reason, /local commit failed/i);
  assert.equal(op.lastError.message, 'db unavailable');
});

test('ambiguous idempotent replay is blocked instead of blindly retrying ABDM', () => {
  for (const status of ['SENT', 'UNKNOWN', 'EXTERNAL_ACCEPTED', 'LOCAL_COMMITTED', 'RECONCILIATION_REQUIRED']) {
    const op = fake(status);
    op.$idempotent = true;
    assert.throws(() => assertSafeIdempotentReplay(op), (error) => error.code === 'ABDM_RECONCILIATION_REQUIRED');
  }
  for (const status of ['CREATED', 'COMPLETED']) {
    const op = fake(status);
    op.$idempotent = true;
    assert.doesNotThrow(() => assertSafeIdempotentReplay(op));
  }
});
