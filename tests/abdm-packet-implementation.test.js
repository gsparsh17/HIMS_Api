const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('ABDM Packet Center exposes preview, prepare, validate, approve, FHIR and disclosure routes', () => {
  const routes = source('routes/abdmHospital.routes.js');
  for (const route of [
    '/patients/:patientId/packets',
    '/care-contexts/:contextId/packet/preview',
    '/care-contexts/:contextId/packet/prepare',
    '/packets/:packetId/versions/:version/summary',
    '/packets/:packetId/versions/:version/fhir',
    '/packets/:packetId/versions/:version/validate',
    '/packets/:packetId/versions/:version/approve',
    '/patients/:patientId/disclosures'
  ]) {
    assert.match(routes, new RegExp(route.replace(/[/:]/g, (value) => value === '/' ? '\\/' : value)));
  }
});

test('packet versions bind immutable source, consent, validation, approval and encrypted FHIR evidence', () => {
  const model = source('models/AbdmPacketVersion.js');
  assert.match(model, /sourceSnapshotHash/);
  assert.match(model, /consentScopeHash/);
  assert.match(model, /bundleHash/);
  assert.match(model, /encryptedBundle/);
  assert.match(model, /select: false/);
  assert.match(model, /approvals/);
  assert.match(model, /validatedBundleHash/);
});

test('HIP transfer uses an approved packet instead of regenerating FHIR at send time', () => {
  const job = source('services/abdmHospitalJob.service.js');
  assert.match(job, /approvedRecordsForTransfer/);
  assert.doesNotMatch(job, /generateAbdmHiBundle/);
  const transfer = source('services/abdmDataTransfer.service.js');
  assert.match(transfer, /ABDM_PACKET_APPROVAL_REQUIRED/);
  assert.match(transfer, /ABDM_PACKET_INTEGRITY_FAILED/);
  assert.match(transfer, /recordDisclosure/);
});

test('all eight NRCeS record profiles are explicitly mapped', () => {
  const profiles = source('config/abdm.profiles.js');
  for (const profile of [
    'PrescriptionRecord',
    'DiagnosticReportRecord',
    'OPConsultRecord',
    'DischargeSummaryRecord',
    'ImmunizationRecord',
    'HealthDocumentRecord',
    'WellnessRecord',
    'InvoiceRecord'
  ]) {
    assert.match(profiles, new RegExp(profile));
  }
});

test('private services and public data-push destinations use separate URL policies', () => {
  const policy = source('utils/safeOutboundUrl.js');
  assert.match(policy, /TRUSTED_INTERNAL_SERVICE/);
  assert.match(policy, /PUBLIC_DATA_PUSH/);
  assert.match(policy, /requireAllowlist: true/);
  assert.match(policy, /allowWildcards: false/);
});
