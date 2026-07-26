const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Patient model does not declare full Aadhaar or plaintext ABHA session tokens', () => {
  const patient = source('models/Patient.js');
  assert.equal(/aadhaar_number\s*:/.test(patient), false);
  assert.equal(/abha\s*:\s*\{[\s\S]*session\s*:/.test(patient), false);
  assert.equal(patient.includes('aadhaar_last4'), true);
  assert.equal(patient.includes('phonePart'), false);
  assert.equal(patient.includes('namePart'), false);
  assert.equal(patient.includes('crypto.randomBytes'), true);
});

test('consent artefacts and imported FHIR are encrypted at rest', () => {
  const consent = source('models/AbdmHospitalConsent.js');
  const imported = source('models/AbdmImportedRecord.js');
  assert.equal(consent.includes('encryptedArtefact'), true);
  assert.equal(/\bartefact\s*:\s*\{\s*type:\s*mongoose/.test(consent), false);
  assert.equal(imported.includes('encryptedFhirBundle'), true);
  assert.equal(/\bfhirBundle\s*:\s*\{\s*type:\s*mongoose/.test(imported), false);
});

test('FHIR generator includes Organization and hospital-scoped persistence', () => {
  const generator = source('services/fhir/abdmHiBundle.service.js');
  assert.equal(generator.includes("resourceType: 'Organization'"), true);
  assert.equal(generator.includes('hospitalId: records.patient.hospitalId'), true);
  assert.equal(generator.includes('custodian:'), true);
});

test('master and public callback route modules are not shipped', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'routes', 'abdmPublic.routes.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'routes', 'abdmMasterAdmin.routes.js')), false);
});
