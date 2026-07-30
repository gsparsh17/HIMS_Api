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

test('deployment files include a private consent-validator service and no published host port', () => {
  const repo = path.join(__dirname, '..');
  const compose = fs.readFileSync(path.join(repo, 'docker-compose.abdm-services.yml'), 'utf8');
  const kubernetes = fs.readFileSync(path.join(repo, 'deployment/k8s/abdm-internal-services.yaml'), 'utf8');
  assert.match(compose, /mediqliq-consent-validator/);
  assert.match(compose, /expose:\s*\n\s*- "8180"/);
  assert.doesNotMatch(compose, /ports:\s*\n\s*- "8180:8180"/);
  assert.match(kubernetes, /kind: NetworkPolicy/);
  assert.match(kubernetes, /CONSENT_VALIDATOR_REQUIRE_MONGO_TRANSACTIONS/);
});
