const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === '../models/AbdmCredential') return {};
  if (request === '../models/Patient') return {};
  if (request === './abdmVault.service') {
    return {
      encryptJson: (value) => value,
      decryptJson: (value) => value
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  normalizeSession,
  sessionStatusFromDates,
  isPatientAccessTokenRejected
} = require('../services/abdmCredential.service');
Module._load = originalLoad;

function unsignedJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.signature`;
}

test('normalizes camelCase and snake_case token response fields', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const accessExp = Math.floor((now + 30 * 60 * 1000) / 1000);
  const refreshExp = Math.floor((now + 15 * 24 * 60 * 60 * 1000) / 1000);
  const session = normalizeSession({
    accessToken: unsignedJwt(accessExp),
    refresh_token: unsignedJwt(refreshExp),
    expires_in: 1800,
    refresh_expires_in: 1296000
  }, now);

  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);
  assert.equal(session.accessExpiresAt.toISOString(), '2026-07-27T12:29:00.000Z');
  assert.equal(session.refreshExpiresAt.toISOString(), '2026-08-11T11:59:00.000Z');
});

test('reports active, refresh-available and reauthentication-required session states', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  assert.equal(sessionStatusFromDates({
    accessExpiresAt: new Date(now + 60_000),
    refreshExpiresAt: new Date(now + 120_000)
  }, now).status, 'ACTIVE');

  const expired = sessionStatusFromDates({
    accessExpiresAt: new Date(now - 60_000),
    refreshExpiresAt: new Date(now + 120_000)
  }, now);
  assert.equal(expired.status, 'REFRESH_AVAILABLE');
  assert.equal(expired.reason, 'ACCESS_TOKEN_EXPIRED');
  assert.equal(expired.hasUnexpiredRefreshToken, true);
});

test('asset controller uses server-side refresh-and-retry and rejects browser token injection', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../controllers/abha.controller'), 'utf8');
  assert.match(source, /withPatientAccessToken/);
  assert.doesNotMatch(source, /req\.headers\[['"]x-token['"]\]/i);
  assert.match(source, /ABHA_REAUTH_REQUIRED|code:\s*error\.code/);
});


test('recognizes ABDM patient X-token rejection even when upstream uses HTTP 400', () => {
  assert.equal(isPatientAccessTokenRejected({
    statusCode: 400,
    details: { error: 'Invalid X-token' }
  }), true);
  assert.equal(isPatientAccessTokenRejected({
    statusCode: 400,
    details: { error: { message: 'Invalid X-token' } }
  }), true);
  assert.equal(isPatientAccessTokenRejected({
    statusCode: 400,
    details: { message: 'Invalid request body' }
  }), false);
  assert.equal(isPatientAccessTokenRejected({ statusCode: 401 }), true);
});
