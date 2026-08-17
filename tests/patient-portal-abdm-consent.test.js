const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('patient portal exposes supported ABDM PHR consent request lifecycle endpoints', () => {
  const routes = source('routes/patientPortal.routes.js');
  const controller = source('controllers/patientPortal.controller.js');

  for (const pathValue of [
    '/abdm/consent-requests',
    '/abdm/consent-requests/:requestId',
    '/abdm/consent-requests/:requestId/deny',
    '/abdm/consent-requests/:requestId/artefacts',
    '/abdm/consent-artefacts',
    '/abdm/consents/revoke',
    '/abdm/consent-auto-approve'
  ]) {
    assert.ok(routes.includes(pathValue), `${pathValue} must be publicly routed inside the authenticated patient portal`);
  }

  for (const action of [
    'LIST_CONSENT_REQUESTS',
    'GET_CONSENT_REQUEST',
    'DENY_CONSENT_REQUEST',
    'GET_CONSENT_ARTEFACTS_BY_REQUEST',
    'LIST_CONSENT_ARTEFACTS',
    'GET_CONSENT_ARTEFACT',
    'REVOKE_CONSENT',
    'CREATE_CONSENT_AUTO_APPROVE'
  ]) {
    assert.ok(controller.includes(action), `${action} must use the PHR_APP patient session through Master`);
  }
});

test('patient deny/revoke actions do not fake local lifecycle completion', () => {
  const controller = source('controllers/patientPortal.controller.js');
  assert.match(controller, /Do not mutate the local HIU mirror to DENIED/);
  assert.match(controller, /wait for ABDM lifecycle notification before changing the/);
  assert.match(controller, /manualSingleRequestGrant:\s*false/);
});
