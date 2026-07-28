const test = require('node:test');
const assert = require('node:assert/strict');
const { structuralValidation, externalRequestBody, normalizeExternalResult } = require('../services/abdmFhirValidation.service');

test('FHIR validation rejects a non-document bundle', () => {
  const result = structuralValidation({ resourceType: 'Bundle', type: 'collection', entry: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});

test('FHIR validation accepts a resolvable supported ABDM document', () => {
  const compositionId = 'urn:uuid:composition';
  const patientId = 'urn:uuid:patient';
  const organizationId = 'urn:uuid:organization';
  const medicationId = 'urn:uuid:medication';
  const profile = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/PrescriptionRecord';
  const result = structuralValidation({
    resourceType: 'Bundle',
    type: 'document',
    timestamp: new Date().toISOString(),
    identifier: { system: 'https://example.test/bundles', value: 'bundle-1' },
    meta: {
      versionId: '1',
      profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/DocumentBundle']
    },
    entry: [
      { fullUrl: compositionId, resource: {
        resourceType: 'Composition', id: 'composition', status: 'final',
        meta: { profile: [profile], versionId: '1' }, type: { text: 'Prescription' },
        subject: { reference: patientId, type: 'Patient' },
        author: [{ reference: organizationId, type: 'Organization' }],
        custodian: { reference: organizationId, type: 'Organization' },
        section: [{ entry: [{ reference: medicationId, type: 'MedicationRequest' }] }]
      } },
      { fullUrl: patientId, resource: { resourceType: 'Patient', id: 'patient' } },
      { fullUrl: organizationId, resource: { resourceType: 'Organization', id: 'organization' } },
      { fullUrl: medicationId, resource: { resourceType: 'MedicationRequest', id: 'medication' } }
    ]
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});


test('HAPI validator-wrapper request pins FHIR R4 and the NRCeS package', () => {
  const request = externalRequestBody({ resourceType: 'Bundle', type: 'document' }, 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/DocumentBundle', 'a'.repeat(64));
  assert.equal(request.validationContext.sv, '4.0.1');
  assert.deepEqual(request.validationContext.igs, ['ndhm.in#6.5.0']);
  assert.equal(request.filesToValidate.length, 1);
  assert.match(request.filesToValidate[0].fileContent, /\"resourceType\":\"Bundle\"/);
});

test('HAPI validator-wrapper issues are normalized fail-closed', () => {
  const result = normalizeExternalResult({
    outcomes: [{ issues: [{ level: 'ERROR', type: 'STRUCTURE', message: 'Required profile is missing', line: 2, col: 4 }] }]
  }, { fhirVersion: '4.0.1', package: 'ndhm.in#6.5.0', bundleHash: 'abc' });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].severity, 'error');
  assert.equal(result.errors[0].code, 'STRUCTURE');
});
