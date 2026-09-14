'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admission financial class is derived from coverage instead of request paymentType', () => {
  const coverage = read('services/coverage.service.js');
  const admission = read('controllers/ipdAdmission.controller.js');
  assert.match(coverage, /function legacyAdmissionPaymentType\(payerType\)/);
  assert.match(coverage, /encounter\.paymentType = legacyAdmissionPaymentType\(payer\.type\)/);
  assert.match(admission, /paymentType: legacyAdmissionPaymentType\(payload\.coverage\?\.payerCategory/);
  assert.doesNotMatch(admission, /paymentType:\s*payload\.paymentType/);
});

test('IPD invoice advance utilisation reads the authoritative shared-wallet ledger', () => {
  const source = read('services/ipdFinancial.service.js');
  assert.match(source, /debitIpdSharedAdvance\(\{/);
  assert.doesNotMatch(source, /advanceAmount:\s*\{\s*\$gte:\s*advanceApplied\s*\}/);
  assert.match(source, /getIpdSharedAdvanceBalance\(\{/);
});

test('pharmacy shared-advance settlement synchronises the admission projection', () => {
  const source = read('services/pharmacyLedgerSettlement.service.js');
  assert.match(source, /if \(walletType === 'IPD_SHARED'\)/);
  assert.match(source, /debitIpdSharedAdvance\(\{/);
});


test('legacy admission advance projection is preserved until the first authoritative ledger row exists', () => {
  const source = read('services/ipdFinancial.service.js');
  assert.match(source, /const hasAuthoritativeAdvanceLedger = patientAdvanceLedger\.length > 0/);
  assert.match(source, /: admission\.advanceAmount\)/);
});
test('final clearance cannot mark a partial unused-advance refund as fully reconciled', () => {
  const source = read('services/ipdFinancial.service.js');
  assert.match(source, /FULL_ADVANCE_RECONCILIATION_REQUIRED/);
  assert.match(source, /\['refunded', 'none'\]\.includes\(disposition\) && advanceAvailable === 0/);
});
