const test = require('node:test');
const assert = require('node:assert/strict');
const { structuralValidation } = require('../services/abdmFhirValidation.service');

test('FHIR validation rejects a non-document bundle', () => {
  const result = structuralValidation({ resourceType: 'Bundle', type: 'collection', entry: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});

test('FHIR validation accepts a minimally structured ABDM document', () => {
  const result = structuralValidation({
    resourceType: 'Bundle',
    type: 'document',
    timestamp: new Date().toISOString(),
    identifier: { value: 'bundle-1' },
    entry: [
      {
        resource: {
          resourceType: 'Composition',
          meta: { profile: ['https://example.test/profile'] }
        }
      },
      { resource: { resourceType: 'Patient' } },
      { resource: { resourceType: 'Organization' } }
    ]
  });
  assert.equal(result.valid, true);
});
