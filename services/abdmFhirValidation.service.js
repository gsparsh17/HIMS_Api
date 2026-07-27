const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

const PROFILE_REQUIREMENTS = {
  PRESCRIPTIONRECORD: ['MedicationRequest'],
  DIAGNOSTICREPORTRECORD: ['DiagnosticReport'],
  OPCONSULTRECORD: ['Encounter'],
  DISCHARGESUMMARYRECORD: ['DocumentReference'],
  IMMUNIZATIONRECORD: ['Immunization'],
  HEALTHDOCUMENTRECORD: ['DocumentReference'],
  WELLNESSRECORD: ['Observation'],
  INVOICERECORD: ['Invoice']
};

function allProfiles(bundle, composition) {
  return [...(bundle?.meta?.profile || []), ...(composition?.meta?.profile || [])]
    .map(String)
    .map((value) => value.toUpperCase());
}

function structuralValidation(bundle) {
  const errors = [];
  const warnings = [];
  if (!bundle || bundle.resourceType !== 'Bundle') errors.push('FHIR document must be a Bundle');
  if (bundle?.type !== 'document') errors.push('FHIR Bundle.type must be document');
  if (!Array.isArray(bundle?.entry) || bundle.entry.length === 0) errors.push('FHIR Bundle.entry must contain resources');

  const entries = bundle?.entry || [];
  const resources = entries.map((entry) => entry.resource).filter(Boolean);
  const composition = resources.find((resource) => resource.resourceType === 'Composition');
  const patient = resources.find((resource) => resource.resourceType === 'Patient');
  const organization = resources.find((resource) => resource.resourceType === 'Organization');
  if (!composition) errors.push('FHIR document is missing Composition');
  if (entries[0]?.resource?.resourceType !== 'Composition') errors.push('Composition must be the first document Bundle entry');
  if (!patient) errors.push('FHIR document is missing Patient');
  if (!organization) errors.push('FHIR document is missing Organization');
  if (!bundle?.identifier?.system || !bundle?.identifier?.value) errors.push('Bundle.identifier system and value are required');
  if (!bundle?.timestamp || Number.isNaN(new Date(bundle.timestamp).getTime())) errors.push('Bundle.timestamp must be a valid instant');

  const fullUrls = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry.fullUrl || !String(entry.fullUrl).startsWith('urn:uuid:')) errors.push(`Entry ${index} must use a urn:uuid fullUrl`);
    if (fullUrls.has(entry.fullUrl)) errors.push(`Duplicate Bundle fullUrl: ${entry.fullUrl}`);
    fullUrls.add(entry.fullUrl);
    if (!entry.resource?.resourceType || !entry.resource?.id) errors.push(`Entry ${index} is missing resourceType or id`);
  }

  if (composition) {
    if (composition.status !== 'final') errors.push('Composition.status must be final');
    if (!composition.type) errors.push('Composition.type is required');
    if (!composition.subject?.reference || !fullUrls.has(composition.subject.reference)) errors.push('Composition.subject must resolve within the Bundle');
    if (!Array.isArray(composition.author) || !composition.author.length) errors.push('Composition.author is required');
    for (const author of composition.author || []) {
      if (!fullUrls.has(author.reference)) errors.push('Composition.author must resolve within the Bundle');
    }
    if (!Array.isArray(composition.section) || !composition.section.length) errors.push('Composition.section is required');
    for (const section of composition.section || []) {
      for (const reference of section.entry || []) {
        if (!fullUrls.has(reference.reference)) errors.push(`Composition section reference does not resolve: ${reference.reference}`);
      }
    }
  }

  const profiles = allProfiles(bundle, composition);
  const recognized = Object.keys(PROFILE_REQUIREMENTS).find((name) => profiles.some((profile) => profile.includes(name)));
  if (!recognized) errors.push('Bundle/Composition profile is not one of the eight supported NRCeS HI document profiles');
  if (recognized) {
    for (const requiredType of PROFILE_REQUIREMENTS[recognized]) {
      if (!resources.some((resource) => resource.resourceType === requiredType)) errors.push(`${recognized} requires a ${requiredType} resource`);
    }
  }

  const localReferences = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value.reference === 'string') localReferences.push(value.reference);
    Object.values(value).forEach(walk);
  };
  resources.forEach(walk);
  for (const reference of localReferences) {
    if (reference.startsWith('http://') || reference.startsWith('https://')) errors.push(`External FHIR reference is not permitted: ${reference}`);
    if (reference.startsWith('urn:uuid:') && !fullUrls.has(reference)) errors.push(`FHIR reference does not resolve: ${reference}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    recognizedProfile: recognized || null,
    resourceCount: resources.length,
    fhirVersion: 'R4',
    implementationGuide: abdmConfig.fhirVersion
  };
}

async function externalValidation(bundle) {
  if (!abdmConfig.fhirValidatorUrl) return null;
  const url = await assertSafeOutboundUrl(abdmConfig.fhirValidatorUrl, {
    label: 'FHIR validator URL',
    allowedHosts: abdmConfig.fhirValidatorAllowedHosts,
    requireHttps: process.env.NODE_ENV === 'production',
    allowPrivate: process.env.NODE_ENV !== 'production'
  });
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json' },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(Number(process.env.ABDM_FHIR_VALIDATOR_TIMEOUT_MS || 30000)),
    redirect: 'error'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || `FHIR validator failed with HTTP ${response.status}`);
    error.details = result;
    throw error;
  }
  return result;
}

function externalIsValid(external) {
  if (!external) return false;
  if (external.valid === true) return true;
  const issues = external.issue || external.issues || [];
  return Array.isArray(issues) && !issues.some((issue) => ['error', 'fatal'].includes(String(issue.severity).toLowerCase()));
}

async function validateBundle(bundle, options = {}) {
  const structural = structuralValidation(bundle);
  if (!structural.valid) return structural;
  if (options.external !== false && abdmConfig.requireExternalFhirValidation && !abdmConfig.fhirValidatorUrl) {
    return { ...structural, valid: false, errors: [...structural.errors, 'External NRCeS FHIR validation is required but ABDM_FHIR_VALIDATOR_URL is not configured'] };
  }
  if (options.external !== false && abdmConfig.fhirValidatorUrl) {
    const external = await externalValidation(bundle);
    return { ...structural, valid: externalIsValid(external), external, errors: externalIsValid(external) ? structural.errors : [...structural.errors, 'External NRCeS FHIR validation failed'] };
  }
  return structural;
}

async function assertValidBundle(bundle, options) {
  const result = await validateBundle(bundle, options);
  if (!result.valid) {
    const error = new Error('FHIR bundle validation failed');
    error.code = 'ABDM_FHIR_VALIDATION_FAILED';
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = { structuralValidation, validateBundle, assertValidBundle, PROFILE_REQUIREMENTS };
