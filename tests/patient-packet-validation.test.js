'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeDocuments,
  buildPacketPlan,
  completionIssues,
  requiresFinalSignature
} = require('../services/patientPacketValidation.service');

test('patient packet deduplicates same canonical source and prefers signed version when both exist', () => {
  const base = { key: 'a', sourceModel: 'OTClinicalForm', sourceId: '1', sourceRevision: 1, documentType: 'consent', title: 'Consent', category: 'consent', templateId: 'x', content: { formData: {} } };
  const result = dedupeDocuments([
    { ...base, status: 'Completed/Unsigned' },
    { ...base, key: 'b', status: 'Final/Signed' }
  ]);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].status, 'Final/Signed');
  assert.equal(result.suppressed.length, 1);
});

test('PMJAY packet is blocked for non-PMJAY encounter', () => {
  const plan = buildPacketPlan({
    packetType: 'pmjay',
    manifest: { payerContext: { isPmjay: false } },
    candidates: []
  });
  assert.equal(plan.validation.ready, false);
  assert.ok(plan.validation.blockers.some((item) => item.code === 'PMJAY_PAYER_REQUIRED'));
});

test('financial packet blocks when billing exists but printable docs are absent', () => {
  const plan = buildPacketPlan({
    packetType: 'financial',
    manifest: { billingSummary: { billCount: 1, invoiceCount: 1, receiptCount: 0 } },
    candidates: []
  });
  assert.ok(plan.validation.blockers.some((item) => item.code === 'FINANCIAL_DOCUMENTS_MISSING'));
});

test('Completed/Unsigned document remains eligible for external packet per client decision', () => {
  const candidate = {
    key: 'unsigned-note', sourceModel: 'IPDRound', sourceId: 'r1', sourceRevision: 1,
    documentType: 'progress_note', title: 'Progress Note', category: 'progress',
    status: 'Completed/Unsigned', metadata: { applicable: true }
  };
  const plan = buildPacketPlan({ packetType: 'clinical', manifest: {}, candidates: [candidate] });
  assert.equal(plan.documents.length, 1);
  assert.equal(plan.documents[0].status, 'Completed/Unsigned');
  assert.equal(plan.validation.ready, true);
});

test('mandatory-field/signature completeness checks are intentionally disabled per client decision', () => {
  assert.deepEqual(completionIssues({ status: 'Final/Signed', content: {} }), []);
  assert.equal(requiresFinalSignature({ sourceModel: 'IPDConsent', status: 'Completed/Unsigned' }), false);
});
