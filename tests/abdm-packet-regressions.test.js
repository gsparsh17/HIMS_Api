const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('packet reads opt encryptedBundle parent and members back into the query', () => {
  const source = read('services/abdmPacket.service.js');
  assert.match(source, /\+encryptedBundle\s+\+encryptedBundle\.ciphertext/);
  assert.match(source, /ABDM_PACKET_ENCRYPTED_PAYLOAD_MISSING/);
  assert.match(source, /ABDM_PACKET_DECRYPT_FAILED/);
});

test('packet validation reports conformance in the body instead of using HTTP 422', () => {
  const source = read('controllers/abdmPacket.controller.js');
  assert.match(source, /validationPassed:\s*result\.validation\.valid === true/);
  assert.doesNotMatch(source, /status\(result\.validation\.valid \? 200 : 422\)/);
});

test('generic FHIR validation reports conformance in the body instead of using HTTP 422', () => {
  const source = read('controllers/abdmHospital.controller.js');
  assert.match(source, /validationPassed:\s*result\.valid === true/);
  assert.doesNotMatch(source, /status\(result\.valid \? 200 : 422\)/);
});

test('external validator requests are pinned to the ABDM R4 preset', () => {
  const source = read('services/abdmFhirValidation.service.js');
  assert.match(source, /ABDM_FHIR_VALIDATOR_BASE_ENGINE\s*\|\|\s*'ABDM_R4'/);
});

test('wellness FHIR generator contains NRCeS R4 identifier and observation coding', () => {
  const source = read('services/fhir/abdmHiBundle.service.js');
  for (const token of [
    "typeCode: 'MR'",
    "typeCode: 'HIN'",
    "typeCode: 'PRN'",
    "code: '85354-9'",
    "'8480-6'",
    "'8462-4'",
    "code: '8867-4'",
    "code: '2708-6'",
    "code: '9279-1'",
    "code: '29463-7'",
    "code: '8302-2'",
    "code: '2339-0'"
  ]) {
    assert.ok(source.includes(token), `missing expected generator token: ${token}`);
  }
  assert.match(source, /language:\s*'en-IN'/);
});
