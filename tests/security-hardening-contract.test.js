'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('patient access and privileged security controls are wired', () => {
  const patientRoutes = read('routes/patient.routes.js');
  const securityRoutes = read('routes/securityAccess.routes.js');
  const auditRoutes = read('routes/auditLog.routes.js');
  assert.match(patientRoutes, /requirePatientAccess/);
  assert.match(securityRoutes, /requirePrivilegedAction\('break_glass_initiate'\)/);
  assert.match(securityRoutes, /requirePrivilegedAction\('break_glass_review'\)/);
  assert.match(auditRoutes, /audit_log_view/);
});

test('ABDM operation ledger treats ambiguous outcomes as reconciliation work', () => {
  const ledger = read('services/abdmOperationLedger.service.js');
  assert.match(ledger, /definitiveReject = statusCode >= 400 && statusCode < 500/);
  assert.match(ledger, /ABDM_OPERATION_PAYLOAD_CONFLICT/);
  assert.match(ledger, /\['CREATED', 'COMPLETED'\]/);
});

test('care-context history is preserved instead of exposing an unlink operation', () => {
  const abha = read('controllers/abha.controller.js');
  assert.match(abha, /ABDM does not support unlinking already linked care contexts/);
});

test('active sessions are invalidated after security-sensitive user changes', () => {
  const auth = read('middlewares/auth.js');
  const userAccess = read('controllers/userAccess.controller.js');
  const token = read('utils/generateToken.js');
  assert.match(auth, /SESSION_REVOKED/);
  assert.match(auth, /currentSecurityVersion/);
  assert.match(userAccess, /SELF_PRIVILEGE_CHANGE_DENIED/);
  assert.match(userAccess, /securityVersion = Number\(user\.securityVersion \|\| 0\) \+ 1/);
  assert.match(token, /securityVersion/);
});

test('delegated MIS work is re-authorized at execution time', () => {
  const delegated = read('services/delegatedJobAuthorization.service.js');
  const worker = read('jobs/misScheduleJob.js');
  assert.match(delegated, /User\.findById/);
  assert.match(delegated, /AUTHORIZATION_REVOKED/);
  assert.match(worker, /delegatedJobAuthorization|authorizeDelegatedJob|assertDelegated/i);
});

test('ABDM consent policy fails closed for revocation, purpose and erase deadline', () => {
  const consent = read('services/abdmConsentPolicy.service.js');
  assert.match(consent, /ABDM_CONSENT_REVOKED/);
  assert.match(consent, /Consent purpose is missing or unsupported/);
  assert.match(consent, /dataEraseAt deadline has passed/);
  assert.match(consent, /validPurposeCodes/);
});

test('browser security correlation headers are accepted by CORS', () => {
  const app = read('app.js');
  assert.match(app, /X-MediQliq-Device-Id/);
  assert.match(app, /X-MediQliq-Operation-Id/);
});

test('security migration is dry-run by default and guards writes behind apply', () => {
  const migration = read('scripts/migrate-security-hardening-v1.js');
  assert.match(migration, /const APPLY = process\.argv\.includes\('--apply'\)/);
  assert.match(migration, /APPLY \? 'APPLY' : 'DRY_RUN'/);
  assert.match(migration, /if \(APPLY && users\.length\)/);
  assert.match(migration, /if \(APPLY && safe/);
});
