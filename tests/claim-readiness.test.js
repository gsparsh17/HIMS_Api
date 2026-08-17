'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateClaimReadinessData } = require('../services/claimReadinessRules.service');

const profile = {
  schemeType: 'pmjay', version: 'test', rules: {
    requireEligibilityVerified: true,
    requireBeneficiaryId: true,
    requirePackageCode: true,
    requireDiagnosis: true,
    requireIcd10: false,
    warnUnsignedClinicalDocuments: true,
    blockCashCollection: true,
    requireDayWiseClinicalCoverage: true,
    requireDischargeSummary: true,
    requirePreauthWhenCoverageSaysRequired: true,
    requireClaimAtOrBelowPreauth: true
  },
  packageRules: []
};

function baseline() {
  return {
    schemeType: 'pmjay',
    claim: { amounts: { claimSubmittedAmount: 45000 }, queries: [], schemeData: { pmjay: { pmjayCaseId: 'CASE-1', finalDiagnosis: 'Fracture', icd10Codes: ['S72.0'], procedureCodes: ['PROC-1'] } } },
    coverage: {
      payerCategory: 'pmjay',
      beneficiary: { beneficiaryId: 'PMJAY-123' },
      eligibility: { status: 'verified' },
      preAuthorisation: { required: true, status: 'approved', approvedAmount: 50000, requestedPackageCode: 'PKG-1' },
      schemeData: { pmjay: { packageCode: 'PKG-1', packageType: 'surgical' } }
    },
    admission: { admissionDate: '2026-07-14T09:30:00Z', dischargeDate: '2026-07-14T17:00:00Z' },
    discharge: { finalDiagnosis: 'Fracture', treatmentGiven: 'Surgery completed', conditionAtDischargeText: 'Stable', followUpDate: '2026-07-21' },
    operativeNotes: [{ status: 'Completed' }],
    evidence: [],
    rounds: [{ roundDateTime: '2026-07-14T10:00:00Z', dailyHistoryAndExamination: 'Reviewed', treatmentPlan: 'Continue treatment' }],
    vitals: [{ recordedAt: '2026-07-14T10:00:00Z' }],
    nursingNotes: [], medications: [], encounterDocuments: [], financialTransactions: [],
    invoices: [{ document_stage: 'ISSUED' }], packageEpisodes: []
  };
}

test('PMJAY beneficiary is a critical readiness requirement', () => {
  const data = baseline();
  data.coverage.beneficiary = {};
  const result = evaluateClaimReadinessData(data, profile);
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.some((row) => row.code === 'PMJAY_BENEFICIARY_ID_MISSING'));
});

test('patient cash collection blocks PMJAY readiness', () => {
  const data = baseline();
  data.financialTransactions = [{ status: 'POSTED', direction: 'CREDIT', transactionType: 'RECEIPT', paymentMethod: 'Cash', amount: 500, transactionNumber: 'TX-1' }];
  const result = evaluateClaimReadinessData(data, profile);
  assert.ok(result.blockers.some((row) => row.code === 'PMJAY_PATIENT_CASH_COLLECTION'));
});

test('claim amount above approved preauthorisation blocks readiness', () => {
  const data = baseline();
  data.claim.amounts.claimSubmittedAmount = 60000;
  const result = evaluateClaimReadinessData(data, profile);
  assert.ok(result.blockers.some((row) => row.code === 'CLAIM_EXCEEDS_PREAUTH'));
});

test('day-wise missing vitals/notes/treatment warns but does not itself block', () => {
  const data = baseline();
  data.vitals = [];
  const result = evaluateClaimReadinessData(data, profile);
  assert.ok(result.warnings.some((row) => row.code === 'PMJAY_DAYWISE_CLINICAL_COVERAGE_INCOMPLETE'));
  assert.equal(result.blockers.length, 0);
});

test('Completed/Unsigned claim document produces warning, not a blocker', () => {
  const data = baseline();
  data.encounterDocuments = [{ status: 'Completed/Unsigned', category: 'consent', title: 'Operation Consent', _id: 'd1' }];
  const result = evaluateClaimReadinessData(data, profile);
  assert.ok(result.warnings.some((row) => row.code === 'PMJAY_UNSIGNED_DOCUMENTS'));
  assert.equal(result.blockers.length, 0);
});

test('package-specific evidence requirement is enforced by rule profile', () => {
  const data = baseline();
  const local = { ...profile, packageRules: [{ packageCode: 'PKG-1', requiredEvidenceTypes: ['POST_PROCEDURE'] }] };
  const result = evaluateClaimReadinessData(data, local);
  assert.ok(result.blockers.some((row) => row.code === 'PMJAY_REQUIRED_EVIDENCE_MISSING'));
});

test('baseline PMJAY claim can be ready or warning-only without critical blockers', () => {
  const result = evaluateClaimReadinessData(baseline(), profile);
  assert.equal(result.blockers.length, 0);
  assert.ok(['ready', 'warning'].includes(result.status));
});
