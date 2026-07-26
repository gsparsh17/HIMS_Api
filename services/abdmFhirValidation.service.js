const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function structuralValidation(bundle) {
  const errors = [];
  const warnings = [];

  if (!bundle || bundle.resourceType !== 'Bundle') {
    errors.push('FHIR document must be a Bundle');
  }
  if (bundle?.type !== 'document') {
    errors.push('FHIR Bundle.type must be document');
  }
  if (!Array.isArray(bundle?.entry) || bundle.entry.length === 0) {
    errors.push('FHIR Bundle.entry must contain resources');
  }

  const resources = (bundle?.entry || []).map((entry) => entry.resource).filter(Boolean);
  const composition = resources.find((resource) => resource.resourceType === 'Composition');
  const patient = resources.find((resource) => resource.resourceType === 'Patient');
  const organization = resources.find((resource) => resource.resourceType === 'Organization');

  if (!composition) errors.push('FHIR document is missing Composition');
  if (!patient) errors.push('FHIR document is missing Patient');
  if (!organization) warnings.push('FHIR document does not contain Organization');

  if (composition && !Array.isArray(composition.meta?.profile)) {
    warnings.push('Composition.meta.profile is missing');
  }
  if (!bundle?.identifier?.value) {
    warnings.push('Bundle.identifier.value is missing');
  }
  if (!bundle?.timestamp) {
    warnings.push('Bundle.timestamp is missing');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
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
    signal: AbortSignal.timeout(
      Number(process.env.ABDM_FHIR_VALIDATOR_TIMEOUT_MS || 30000)
    ),
    redirect: 'error'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      result.message || `FHIR validator failed with HTTP ${response.status}`
    );
    error.details = result;
    throw error;
  }
  return result;
}

async function validateBundle(bundle, options = {}) {
  const structural = structuralValidation(bundle);
  if (!structural.valid) return structural;

  if (
    options.external !== false &&
    abdmConfig.requireExternalFhirValidation &&
    !abdmConfig.fhirValidatorUrl
  ) {
    return {
      ...structural,
      valid: false,
      errors: [
        ...structural.errors,
        'External NRCeS FHIR validation is required but ABDM_FHIR_VALIDATOR_URL is not configured'
      ]
    };
  }

  if (options.external !== false && abdmConfig.fhirValidatorUrl) {
    const external = await externalValidation(bundle);
    const externalErrors = external?.errors || external?.issues?.filter(
      (issue) => ['error', 'fatal'].includes(issue.severity)
    );
    return {
      ...structural,
      valid: !externalErrors?.length,
      external
    };
  }
  return structural;
}

async function assertValidBundle(bundle, options) {
  const result = await validateBundle(bundle, options);
  if (!result.valid) {
    const error = new Error('FHIR bundle validation failed');
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  structuralValidation,
  validateBundle,
  assertValidBundle
};
