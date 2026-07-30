const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePolicy } = require('../src/policy');

const claims = {
  consentId: 'CONSENT-1',
  status: 'GRANTED',
  patientId: 'patient@abdm',
  hipIds: ['HIP-1'],
  hiuId: 'HIU-1',
  purpose: { code: 'CAREMGT' },
  hiTypes: ['OPConsultRecord'],
  careContextIds: ['CC-1'],
  dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z' },
  validFrom: '2026-01-01T00:00:00.000Z',
  expiresAt: '2027-01-31T23:59:59.999Z',
  dataEraseAt: '2027-01-31T23:59:59.999Z',
  frequency: { unit: 'HOUR', value: 1, repeats: 0 }
};

const operation = {
  type: 'HIP_DISCLOSURE',
  operationId: 'TX-1',
  hospitalId: 'HOSPITAL-1',
  patientId: 'patient@abdm',
  hipId: 'HIP-1',
  hiuId: 'HIU-1',
  purpose: 'CAREMGT',
  hiTypes: ['OPConsultRecord'],
  careContextIds: ['CC-1'],
  dateRange: { from: '2026-02-01T00:00:00.000Z', to: '2026-02-28T23:59:59.999Z' },
  packetHash: 'sha256:packet'
};

test('permits an operation fully inside consent scope', () => {
  const result = evaluatePolicy({ claims, operation, now: new Date('2026-07-29T00:00:00Z') });
  assert.equal(result.decision, 'PERMIT');
  assert.equal(result.frequency.maxUses, 1);
});

test('denies a wrong purpose', () => {
  const result = evaluatePolicy({ claims, operation: { ...operation, purpose: 'RESEARCH' }, now: new Date('2026-07-29T00:00:00Z') });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'CONSENT_PURPOSE_MISMATCH'));
});

test('denies a care context outside consent scope', () => {
  const result = evaluatePolicy({ claims, operation: { ...operation, careContextIds: ['CC-2'] }, now: new Date('2026-07-29T00:00:00Z') });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'CONSENT_CARE_CONTEXT_NOT_AUTHORIZED'));
});

test('denies revoked lifecycle status', () => {
  const result = evaluatePolicy({ claims, operation, lifecycleStatus: 'REVOKED', now: new Date('2026-07-29T00:00:00Z') });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'CONSENT_REVOKED'));
});

test('denies wrong patient, HIP, HIU, HI type and wider date range', () => {
  const scenarios = [
    [{ ...operation, patientId: 'other@abdm' }, 'CONSENT_PATIENT_MISMATCH'],
    [{ ...operation, hipId: 'HIP-2' }, 'CONSENT_HIP_MISMATCH'],
    [{ ...operation, hiuId: 'HIU-2' }, 'CONSENT_HIU_MISMATCH'],
    [{ ...operation, hiTypes: ['DischargeSummaryRecord'] }, 'CONSENT_HI_TYPE_NOT_AUTHORIZED'],
    [{ ...operation, dateRange: { from: '2025-12-31T00:00:00Z', to: operation.dateRange.to } }, 'CONSENT_DATE_RANGE_EXCEEDED']
  ];
  for (const [candidate, code] of scenarios) {
    const result = evaluatePolicy({ claims, operation: candidate, now: new Date('2026-07-29T00:00:00Z') });
    assert.equal(result.decision, 'DENY');
    assert.ok(result.issues.some((item) => item.code === code), code);
  }
});

test('denies unsupported operation types rather than treating them as a weak policy profile', () => {
  const result = evaluatePolicy({
    claims,
    operation: { ...operation, type: 'CUSTOM_BYPASS' },
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'OPERATION_TYPE_UNSUPPORTED'));
});

test('requires HIP identity for inbound HIU import', () => {
  const result = evaluatePolicy({
    claims,
    operation: {
      ...operation,
      type: 'HIU_IMPORT',
      packetHash: undefined,
      hipId: undefined,
      payloadHash: 'payload-hash'
    },
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'OPERATION_HIP_MISSING'));
});

test('denies retention beyond consent', () => {
  const result = evaluatePolicy({
    claims,
    operation: { ...operation, retentionUntil: '2028-01-01T00:00:00Z' },
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'CONSENT_RETENTION_EXCEEDED'));
});


test('a local GRANTED lifecycle event cannot elevate a non-granted signed artefact', () => {
  const result = evaluatePolicy({
    claims: { ...claims, status: 'REVOKED' },
    operation,
    lifecycleStatus: 'GRANTED',
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.equal(result.decision, 'DENY');
  assert.ok(result.issues.some((item) => item.code === 'CONSENT_REVOKED'));
});


test('strict operations require hospital binding and HIU imports require exact payload binding', () => {
  const noHospital = evaluatePolicy({
    claims,
    operation: { ...operation, hospitalId: undefined },
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.ok(noHospital.issues.some((item) => item.code === 'OPERATION_HOSPITAL_MISSING'));

  const noPayload = evaluatePolicy({
    claims,
    operation: { ...operation, type: 'HIU_IMPORT', packetHash: undefined, payloadHash: undefined },
    now: new Date('2026-07-29T00:00:00Z')
  });
  assert.ok(noPayload.issues.some((item) => item.code === 'OPERATION_PAYLOAD_HASH_MISSING'));
});
