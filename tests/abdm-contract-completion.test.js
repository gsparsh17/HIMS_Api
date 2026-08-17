const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('wrong-patient ABDM profiles are rejected before VERIFIED state', () => {
  const { assessPatientIdentity } = require('../services/abdmIdentityMatch.service');
  const result = assessPatientIdentity(
    {
      first_name: 'Rajesh',
      last_name: 'Sharma',
      dob: new Date('2002-07-01T00:00:00.000Z'),
      gender: 'male',
      phone: '9876547777'
    },
    {
      firstName: 'Pranshu',
      lastName: 'Pandey',
      dob: '24-04-2004',
      gender: 'M',
      mobile: '7459963373',
      ABHANumber: '91-7257-4615-6027'
    }
  );
  assert.equal(result.matched, false);
  assert.ok(result.mismatchedFields.includes('DOB'));
  assert.ok(result.mismatchedFields.includes('MOBILE'));
  assert.ok(result.mismatchedFields.includes('NAME'));
});

test('M1 uses official refresh, address, profile and logout surfaces', () => {
  const credentials = source('services/abdmCredential.service.js');
  const controller = source('controllers/abha.controller.js');
  assert.match(credentials, /\/v3\/profile\/account\/request\/token/);
  assert.match(credentials, /'R-token': `Bearer \$\{session\.refreshToken\}`/);
  assert.match(controller, /\/v3\/enrollment\/enrol\/suggestion/);
  assert.match(controller, /\/v3\/enrollment\/enrol\/abha-address/);
  assert.match(controller, /\/v3\/profile\/account\/request\/logout/);
  assert.match(controller, /exports\.getProfile/);
});

test('M1 optional document, password and biometric login flows are routed', () => {
  const routes = source('routes/abha.routes.js');
  for (const route of [
    '/login/password/search',
    '/login/password/verify',
    '/document/request-otp',
    '/document/verify-otp',
    '/document/enrol',
    '/biometric/init',
    '/biometric/capture-pid',
    '/biometric/enrol'
  ]) {
    assert.ok(routes.includes(route), `${route} must be mounted`);
  }
});

test('M2 data push includes pagination and HIP notification identity', () => {
  const transfer = source('services/abdmDataTransfer.service.js');
  const jobs = source('services/abdmHospitalJob.service.js');
  assert.match(transfer, /pageNumber/);
  assert.match(transfer, /pageCount/);
  assert.match(jobs, /statusNotification:[\s\S]*hipId:/);
});

test('M3 uses exact request wrappers and final success/failure notification', () => {
  const hiu = source('services/abdmHiuHospital.service.js');
  assert.match(hiu, /body: \{ consentRequestId: consent\.consentRequestId \}/);
  assert.match(hiu, /body: \{ consentId: consent\.consentId \}/);
  assert.match(hiu, /const body = \{\s*hiRequest:/);
  assert.match(hiu, /action: 'NOTIFY_HEALTH_INFORMATION'/);
  assert.match(hiu, /status: 'RECEIVED'/);
  assert.match(hiu, /hiStatus: status === 'RECEIVED' \? 'OK' : 'ERRORED'/);
  assert.match(hiu, /hiu: \{ id: hiuId \}/);
  assert.match(hiu, /identifier: \{/);
  assert.match(hiu, /status: 'FAILED'/);
  assert.match(hiu, /assertDecryptionIntegrity/);
  const connector = source('controllers/abdmHiuConnector.controller.js');
  assert.match(connector, /const acknowledgement = artefactIds\.map/);
  assert.match(connector, /acknowledgement,/);
});

test('running-token, deep-link and subscription backend routes are present', () => {
  const m2Routes = source('routes/abdmHospital.routes.js');
  const hiuRoutes = source('routes/abdmHiu.routes.js');
  assert.ok(m2Routes.includes('/linking/hip/sms/:patientId'));
  assert.ok(m2Routes.includes('/running-token/status/:patientId'));
  assert.ok(hiuRoutes.includes('/subscriptions/remote/:subscriptionId'));
  assert.ok(hiuRoutes.includes('/subscriptions/lockers/setup'));
});
