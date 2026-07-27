const test = require('node:test');
const assert = require('node:assert/strict');
const { structuralValidation } = require('../services/abdmFhirValidation.service');

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
    meta: { profile: [profile] },
    entry: [
      { fullUrl: compositionId, resource: {
        resourceType: 'Composition', id: 'composition', status: 'final',
        meta: { profile: [profile] }, type: { text: 'Prescription' },
        subject: { reference: patientId }, author: [{ reference: organizationId }],
        section: [{ entry: [{ reference: medicationId }] }]
      } },
      { fullUrl: patientId, resource: { resourceType: 'Patient', id: 'patient' } },
      { fullUrl: organizationId, resource: { resourceType: 'Organization', id: 'organization' } },
      { fullUrl: medicationId, resource: { resourceType: 'MedicationRequest', id: 'medication' } }
    ]
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
