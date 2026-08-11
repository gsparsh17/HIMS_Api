const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertVerifiedScopeMatches } = require('../services/abdmConsentValidationContract');

const operation = {
  type: 'HIP_DISCLOSURE',
  operationId: 'TX-1',
  patientId: 'patient@abdm',
  hipId: 'HIP-1',
  hiuId: 'HIU-1',
  purpose: { code: 'CAREMGT' },
  hiTypes: ['Prescription'],
  careContextIds: ['CC-1'],
  dateRange: {
    from: '2026-01-10T00:00:00.000Z',
    to: '2026-01-20T00:00:00.000Z'
  },
  packetHash: 'packet-hash'
};

const response = {
  lifecycleStatus: 'GRANTED',
  trust: { issuer: 'issuer', keyId: 'kid', algorithm: 'RS256' },
  verifiedScope: {
    consentId: 'CONSENT-1',
    status: 'GRANTED',
    patientId: 'patient@abdm',
    hipIds: ['HIP-1'],
    hiuId: 'HIU-1',
    purpose: { code: 'CAREMGT' },
    hiTypes: ['Prescription'],
    careContextIds: ['CC-1'],
    dateRange: {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z'
    }
  }
};

test('hospital independently verifies the claims-rich consent-validator response', () => {
  assert.equal(assertVerifiedScopeMatches(response, operation, {
    consentId: 'CONSENT-1',
    patientId: 'patient@abdm',
    hipId: 'HIP-1',
    hiuId: 'HIU-1'
  }), true);
});

test('hospital rejects a bare or mismatched valid response', () => {
  assert.throws(
    () => assertVerifiedScopeMatches({ trust: { algorithm: 'RS256' } }, operation, {}),
    (error) => error.code === 'ABDM_CONSENT_VALIDATOR_SCOPE_INVALID'
  );
  assert.throws(
    () => assertVerifiedScopeMatches({
      ...response,
      verifiedScope: { ...response.verifiedScope, hiuId: 'WRONG-HIU' }
    }, operation, { hiuId: 'HIU-1' }),
    (error) => error.code === 'ABDM_CONSENT_VALIDATOR_SCOPE_INVALID'
  );
});

test('hospital repository no longer owns the shared validator/crypto/consent deployments', () => {
  const repo = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(repo, 'docker-compose.abdm-services.yml')), false);
  assert.equal(fs.existsSync(path.join(repo, 'deployment/k8s/abdm-internal-services.yaml')), false);
  assert.equal(fs.existsSync(path.join(repo, 'apps/fhir-validator')), false);
  assert.equal(fs.existsSync(path.join(repo, 'apps/crypto-adapter')), false);
  assert.equal(fs.existsSync(path.join(repo, 'apps/consent-validator')), false);
});
