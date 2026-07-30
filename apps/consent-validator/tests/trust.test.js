const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { canonicalJson } = require('../src/canonical');
const { verifyConsentProof, jwksStore } = require('../src/trust');
const { config } = require('../src/config');


test.beforeEach(() => {
  jwksStore.cached = null;
  jwksStore.expiresAt = 0;
  jwksStore.lastError = null;
  jwksStore.lastRefreshAt = null;
  config.expectedIssuers.length = 0;
  config.expectedAudiences.length = 0;
});

function jws(payload, privateKey, kid = 'test-key') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

test('verifies compact JWS and binds signed consent payload', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'test-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  config.pinnedJwks = { keys: [publicJwk] };
  config.expectedIssuers.length = 0;
  const consentDetail = {
    id: 'CONSENT-1',
    status: 'GRANTED',
    patient: { id: 'patient@abdm' },
    hip: { id: 'HIP-1' },
    hiu: { id: 'HIU-1' },
    purpose: { code: 'CAREMGT' },
    permission: {
      dateRange: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
      dataEraseAt: '2027-01-01T00:00:00Z',
      hiTypes: ['OPConsultRecord']
    }
  };
  const proof = jws({ consentDetail }, privateKey);
  const result = await verifyConsentProof({ artefact: { consentDetail, signature: proof } });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.integrityVerified, true);
  assert.equal(canonicalJson(result.verifiedArtefact), canonicalJson(consentDetail));
});

test('rejects a modified outer consent even when the compact JWS remains valid', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'tamper-key';
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  config.pinnedJwks = { keys: [publicJwk] };
  const consentDetail = {
    id: 'CONSENT-TAMPER',
    patient: { id: 'patient@abdm' },
    hip: { id: 'HIP-1' },
    hiu: { id: 'HIU-1' },
    purpose: { code: 'CAREMGT' },
    permission: {
      dateRange: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' },
      dataEraseAt: '2027-01-01T00:00:00Z',
      hiTypes: ['OPConsultRecord']
    }
  };
  const proof = jws({ consentDetail }, privateKey, 'tamper-key');
  await assert.rejects(
    verifyConsentProof({
      artefact: {
        consentDetail: {
          ...consentDetail,
          permission: { ...consentDetail.permission, hiTypes: ['DischargeSummaryRecord'] }
        },
        signature: proof
      }
    }),
    (error) => error.code === 'CONSENT_PAYLOAD_BINDING_FAILED'
  );
});

test('rejects a compact JWS signed by an unknown key', async () => {
  const trusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const trustedJwk = trusted.publicKey.export({ format: 'jwk' });
  trustedJwk.kid = 'trusted-key';
  trustedJwk.use = 'sig';
  trustedJwk.alg = 'RS256';
  config.pinnedJwks = { keys: [trustedJwk] };
  const consentDetail = { id: 'CONSENT-UNKNOWN-KEY' };
  const proof = jws({ consentDetail }, attacker.privateKey, 'attacker-key');
  await assert.rejects(
    verifyConsentProof({ artefact: { consentDetail, signature: proof } }),
    (error) => error.code === 'CONSENT_SIGNING_KEY_UNKNOWN'
  );
});
