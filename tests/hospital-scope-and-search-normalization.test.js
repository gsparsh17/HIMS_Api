const test = require('node:test');
const assert = require('node:assert/strict');

const {
  userHospitalId,
  assertUserHospital,
  requestHospitalId,
  isPlatformAdmin
} = require('../utils/hospitalScope');
const {
  flexibleDigitRegex,
  canonicalStatusKey,
  abhaStatusFilter,
  patientSearchConditions
} = require('../utils/searchNormalization');

test('userHospitalId accepts historical hospital key spellings', () => {
  for (const key of ['hospital_id', 'hospitalId', 'hospitalID', 'hospital']) {
    assert.equal(String(userHospitalId({ [key]: '507f1f77bcf86cd799439011' })), '507f1f77bcf86cd799439011');
  }
  assert.equal(userHospitalId({}), null);
});

test('userHospitalId unwraps populated hospital documents', () => {
  assert.equal(
    String(userHospitalId({ hospital_id: { _id: '507f1f77bcf86cd799439011' } })),
    '507f1f77bcf86cd799439011'
  );
});

test('assertUserHospital rejects missing tenant context', () => {
  assert.throws(() => assertUserHospital({}), /not assigned to a hospital/i);
});

test('requestHospitalId does not let regular users switch tenant through request casing variants', () => {
  const req = {
    user: { role: 'Admin', hospital_id: 'hospital-a' },
    body: { hospitalId: 'hospital-b' },
    query: { hospital_id: 'hospital-c' },
    headers: { 'x-hospital-id': 'hospital-d' }
  };
  assert.equal(requestHospitalId(req), 'hospital-a');
});

test('platform admin role comparison is case-insensitive', () => {
  assert.equal(isPlatformAdmin({ role: 'MEDIQLIQ_SUPER_ADMIN' }), true);
  assert.equal(requestHospitalId({
    user: { role: 'MEDIQLIQ_SUPER_ADMIN' },
    query: { hospitalId: 'hospital-z' }
  }), 'hospital-z');
});

test('ABHA status aliases are normalized regardless of case', () => {
  assert.equal(canonicalStatusKey('verified'), 'VERIFIED');
  assert.equal(canonicalStatusKey('Pending-Verification'), 'VERIFICATION_PENDING');
  const filter = abhaStatusFilter('Otp Sent');
  assert.equal(filter.$in.some((regex) => regex.test('OTP_SENT')), true);
  assert.equal(filter.$in.some((regex) => regex.test('otp_sent')), true);
});

test('patient search is case-insensitive and ABHA-number formatting tolerant', () => {
  const textConditions = patientSearchConditions('rAjEs');
  assert.equal(textConditions.some((condition) => condition.first_name?.test('Rajesh')), true);

  const digits = flexibleDigitRegex('91725746156027');
  assert.equal(digits.test('91-7257-4615-6027'), true);
});

test('multi-part patient names can match across first and last name fields', () => {
  const conditions = patientSearchConditions('Rajesh Sharma');
  const compound = conditions.find((condition) => condition.$and);
  assert.ok(compound);
  assert.equal(compound.$and.length, 2);
});

test('backend source does not read non-canonical req.user hospital aliases directly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const roots = ['controllers', 'services', 'middlewares', 'routes', 'jobs'];
  const offenders = [];
  const directAlias = /req\.user\??\.(?:hospital|hospitalId|hospitalID)(?![A-Za-z0-9_])/;

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = fs.readFileSync(fullPath, 'utf8');
        if (directAlias.test(source)) offenders.push(fullPath);
      }
    }
  }

  roots.forEach(walk);
  assert.deepEqual(offenders, []);
});

test('ABHA patient search returns only allow-listed ABHA fields', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../controllers/abha.controller'), 'utf8');
  const start = source.indexOf('exports.searchPatientsByAbha');
  const end = source.indexOf('const RECORD_MODELS', start);
  const searchHandler = source.slice(start, end);

  assert.match(searchHandler, /'abha\.number'/);
  assert.match(searchHandler, /abha:\s*safeAbha\(patient\)/);
  assert.doesNotMatch(searchHandler, /patient_type abha registered_at/);
  assert.doesNotMatch(searchHandler, /abha\.session/);
});
