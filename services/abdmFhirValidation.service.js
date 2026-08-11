const abdmConfig = require('../config/abdm.config');
const {
  OUTBOUND_POLICIES,
  assertSafeOutboundUrl
} = require('../utils/safeOutboundUrl');
const { canonicalJson, sha256, timingSafeEqualText } = require('../utils/abdmCanonical');
const { PROFILE_NAMES } = require('../config/abdm.profiles');
const { masterRequest } = require('./abdmMasterClient.service');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

const DOCUMENT_BUNDLE_PROFILE = `${abdmConfig.fhirProfileBase}/DocumentBundle`;
const PROFILE_REQUIREMENTS = {
  PRESCRIPTIONRECORD: ['MedicationRequest'],
  DIAGNOSTICREPORTRECORD: ['DiagnosticReport'],
  OPCONSULTRECORD: ['Encounter'],
  DISCHARGESUMMARYRECORD: ['Encounter'],
  IMMUNIZATIONRECORD: ['Immunization'],
  HEALTHDOCUMENTRECORD: ['DocumentReference'],
  WELLNESSRECORD: ['Observation'],
  INVOICERECORD: ['Invoice']
};

function profileNameFromUrl(value) {
  return String(value || '').split('/').pop().split('|')[0].toUpperCase();
}

function compositionProfile(composition) {
  return (composition?.meta?.profile || [])
    .map(profileNameFromUrl)
    .find((name) => Object.prototype.hasOwnProperty.call(PROFILE_REQUIREMENTS, name)) || null;
}

function walkReferences(value, visitor) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach((item) => walkReferences(item, visitor));
  if (typeof value.reference === 'string') visitor(value);
  Object.values(value).forEach((item) => walkReferences(item, visitor));
}

function structuralValidation(bundle) {
  const errors = [];
  const warnings = [];
  if (!bundle || bundle.resourceType !== 'Bundle') errors.push('FHIR document must be a Bundle');
  if (bundle?.type !== 'document') errors.push('FHIR Bundle.type must be document');
  if (!Array.isArray(bundle?.entry) || bundle.entry.length === 0) errors.push('FHIR Bundle.entry must contain resources');
  if (!bundle?.meta?.versionId) errors.push('FHIR Bundle.meta.versionId is required');
  if (!(bundle?.meta?.profile || []).some((profile) => String(profile).split('|')[0] === DOCUMENT_BUNDLE_PROFILE)) {
    errors.push('FHIR Bundle.meta.profile must declare the NRCeS DocumentBundle profile');
  }

  const entries = bundle?.entry || [];
  const resources = entries.map((entry) => entry.resource).filter(Boolean);
  const composition = entries[0]?.resource;
  const patient = resources.find((resource) => resource.resourceType === 'Patient');
  const organization = resources.find((resource) => resource.resourceType === 'Organization');
  if (!composition || composition.resourceType !== 'Composition') errors.push('Composition must be the first document Bundle entry');
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

  const recognized = compositionProfile(composition);
  if (composition?.resourceType === 'Composition') {
    if (composition.status !== 'final') errors.push('Composition.status must be final');
    if (!composition.type) errors.push('Composition.type is required');
    if (!composition.meta?.versionId) errors.push('Composition.meta.versionId is required');
    if (!recognized) errors.push('Composition.meta.profile is not one of the eight supported NRCeS record profiles');
    if (!composition.subject?.reference || !fullUrls.has(composition.subject.reference)) errors.push('Composition.subject must resolve within the Bundle');
    if (!Array.isArray(composition.author) || !composition.author.length) errors.push('Composition.author is required');
    for (const author of composition.author || []) {
      if (!fullUrls.has(author.reference)) errors.push('Composition.author must resolve within the Bundle');
    }
    if (!composition.custodian?.reference || !fullUrls.has(composition.custodian.reference)) {
      errors.push('Composition.custodian must resolve within the Bundle');
    }
    if (!Array.isArray(composition.section) || !composition.section.length) errors.push('Composition.section is required');
    for (const section of composition.section || []) {
      for (const reference of section.entry || []) {
        if (!fullUrls.has(reference.reference)) errors.push(`Composition section reference does not resolve: ${reference.reference}`);
        if (!reference.type) errors.push(`Composition section reference must include Reference.type: ${reference.reference}`);
      }
    }
  }

  if (recognized) {
    for (const requiredType of PROFILE_REQUIREMENTS[recognized]) {
      if (!resources.some((resource) => resource.resourceType === requiredType)) errors.push(`${recognized} requires a ${requiredType} resource`);
    }
    if (['OPCONSULTRECORD', 'DISCHARGESUMMARYRECORD'].includes(recognized)) {
      if (!composition?.encounter?.reference || !fullUrls.has(composition.encounter.reference)) {
        errors.push(`${recognized} requires a resolvable Composition.encounter`);
      }
    }
  }

  resources.forEach((resource) => {
    walkReferences(resource, (reference) => {
      const value = reference.reference;
      if (value.startsWith('http://') || value.startsWith('https://')) errors.push(`External FHIR reference is not permitted: ${value}`);
      if (value.startsWith('urn:uuid:') && !fullUrls.has(value)) errors.push(`FHIR reference does not resolve: ${value}`);
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    recognizedProfile: recognized,
    resourceCount: resources.length,
    fhirVersion: abdmConfig.fhirR4Version,
    implementationGuide: abdmConfig.fhirVersion,
    package: abdmConfig.fhirPackage,
    bundleHash: sha256(canonicalJson(bundle), true)
  };
}

function internalServiceHeaders() {
  const token = process.env.ABDM_FHIR_VALIDATOR_TOKEN || abdmConfig.internalServiceAuthToken;
  const headers = {
    'Content-Type': 'application/json',
    'X-MediQliq-Service-Identity': process.env.ABDM_INTERNAL_SERVICE_IDENTITY || 'ABDM_MASTER',
    ...(abdmConfig.tenantCode ? { 'X-MediQliq-Tenant-Code': abdmConfig.tenantCode } : {}),
    ...(abdmConfig.hipId ? { 'X-MediQliq-Facility-ID': abdmConfig.hipId } : {}),
    ...(abdmConfig.hfrFacilityId ? { 'X-MediQliq-HFR-ID': abdmConfig.hfrFacilityId } : {})
  };
  if (abdmConfig.internalServiceAuthToken) {
    headers[abdmConfig.internalServiceAuthHeader] = abdmConfig.internalServiceAuthToken;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function safeInternalUrl(rawUrl, label) {
  return assertSafeOutboundUrl(rawUrl, {
    policy: OUTBOUND_POLICIES.TRUSTED_INTERNAL_SERVICE,
    label,
    allowedHosts: abdmConfig.trustedInternalServiceHosts.length
      ? abdmConfig.trustedInternalServiceHosts
      : abdmConfig.fhirValidatorAllowedHosts,
    allowedPorts: abdmConfig.trustedInternalServicePorts
  });
}

async function readJsonResponse(response, maxBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) {
    const error = new Error('FHIR validator response exceeded the configured size limit');
    error.code = 'ABDM_FHIR_VALIDATOR_RESPONSE_TOO_LARGE';
    throw error;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    const error = new Error('FHIR validator returned invalid JSON');
    error.code = 'ABDM_FHIR_VALIDATOR_INVALID_JSON';
    throw error;
  }
}

function redactIssueMessage(value) {
  return String(value || 'FHIR validation issue')
    .replace(/"[^"\n]{4,}"/g, '"[REDACTED]"')
    .replace(/\b\d{10,16}\b/g, '[REDACTED_IDENTIFIER]')
    .slice(0, 500);
}

function normalizeSeverity(value) {
  const severity = String(value || 'error').toLowerCase();
  if (severity === 'information' || severity === 'informational' || severity === 'hint') return 'information';
  if (severity === 'warning') return 'warning';
  if (severity === 'fatal') return 'fatal';
  return 'error';
}

function normalizeIssue(issue = {}) {
  const severity = normalizeSeverity(issue.severity || issue.level || issue.issueSeverity);
  const path = issue.path || issue.expression?.[0] || issue.location?.[0] || issue.diagnosticsPath;
  return {
    severity,
    code: String(issue.code || issue.type || issue.messageId || issue.details?.coding?.[0]?.code || 'PROFILE_CONFORMANCE').toUpperCase(),
    path: path ? String(path).slice(0, 500) : undefined,
    line: Number.isFinite(Number(issue.line)) ? Number(issue.line) : undefined,
    column: Number.isFinite(Number(issue.col || issue.column)) ? Number(issue.col || issue.column) : undefined,
    message: redactIssueMessage(issue.message || issue.diagnostics || issue.details?.text)
  };
}

function wrapperIssues(raw = {}) {
  if (!Array.isArray(raw.outcomes)) return [];
  return raw.outcomes.flatMap((outcome) => Array.isArray(outcome?.issues) ? outcome.issues : []);
}

function normalizeExternalResult(raw = {}, expected = {}) {
  const wrapper = wrapperIssues(raw);
  const rawIssues = wrapper.length
    ? wrapper
    : (raw.errors || raw.issue || raw.issues || raw.operationOutcome?.issue || []);
  const rawWarnings = raw.warnings || [];
  const normalized = [...(Array.isArray(rawIssues) ? rawIssues : []), ...(Array.isArray(rawWarnings) ? rawWarnings : [])]
    .map(normalizeIssue);
  const errors = normalized.filter((issue) => ['fatal', 'error'].includes(issue.severity));
  const warnings = normalized.filter((issue) => !['fatal', 'error'].includes(issue.severity));
  const explicitlyValid = raw.valid === true;
  const wrapperCompleted = Array.isArray(raw.outcomes) && raw.outcomes.length > 0;
  const valid = errors.length === 0 && (explicitlyValid || wrapperCompleted);
  return {
    valid,
    errors,
    warnings,
    fhirVersion: raw.fhirVersion || expected.fhirVersion,
    package: raw.package || expected.package,
    profile: raw.profile || expected.profile,
    bundleHash: raw.bundleHash || expected.bundleHash,
    validatedAt: raw.validatedAt || new Date().toISOString(),
    validatorVersion: raw.validatorVersion || raw.version || raw.appVersion
  };
}

function externalRequestBody(bundle, expectedProfile, bundleHash) {
  if (abdmConfig.fhirValidatorMode !== 'hapi-wrapper') {
    return {
      bundle,
      expectedProfile,
      bundleHash,
      fhirVersion: abdmConfig.fhirR4Version,
      package: abdmConfig.fhirPackage
    };
  }

  return {
    validationContext: {
      sv: abdmConfig.fhirR4Version,
      locale: 'en',
      igs: [abdmConfig.fhirPackage],
      profiles: expectedProfile ? [expectedProfile] : [],
      extensions: ['any'],
      assumeValidRestReferences: false,
      hintAboutNonMustSupport: true
    },
    filesToValidate: [
      {
        fileName: `abdm-bundle-${bundleHash.slice(0, 16)}.json`,
        fileContent: canonicalJson(bundle)
      }
    ]
  };
}

function providerConfigured(provider) {
  if (provider === 'master') return Boolean(abdmConfig.masterUrl);
  if (provider === 'local') return Boolean(abdmConfig.fhirValidatorUrl);
  return false;
}

function providerUnavailable(error) {
  const status = Number(error?.statusCode || 0);
  return !status || status >= 500 || [
    'ABDM_INTERNAL_SERVICE_TIMEOUT',
    'ABDM_INTERNAL_SERVICE_UNAVAILABLE',
    'ABDM_MASTER_UNAVAILABLE',
    'ABDM_FHIR_VALIDATOR_UNREACHABLE'
  ].includes(error?.code);
}

async function localExternalValidation(bundle, expectedProfile) {
  if (!abdmConfig.fhirValidatorUrl) return null;
  const url = await safeInternalUrl(abdmConfig.fhirValidatorUrl, 'FHIR validator URL');
  const bundleHash = sha256(canonicalJson(bundle), true);
  const response = await fetchFn(url, {
    method: 'POST',
    headers: internalServiceHeaders(),
    body: JSON.stringify(externalRequestBody(bundle, expectedProfile, bundleHash)),
    signal: AbortSignal.timeout(abdmConfig.fhirValidatorTimeoutMs),
    redirect: 'error'
  });
  const raw = await readJsonResponse(response, abdmConfig.fhirValidatorMaxResponseBytes);
  if (!response.ok) {
    const error = new Error(raw.message || `FHIR validator failed with HTTP ${response.status}`);
    error.code = raw.code || 'ABDM_FHIR_VALIDATOR_HTTP_ERROR';
    error.statusCode = response.status;
    error.details = normalizeExternalResult(raw, {
      fhirVersion: abdmConfig.fhirR4Version,
      package: abdmConfig.fhirPackage,
      profile: expectedProfile,
      bundleHash
    });
    throw error;
  }
  return { raw, bundleHash };
}

async function masterExternalValidation(bundle, expectedProfile) {
  abdmConfig.assertHospitalConnector();
  const bundleHash = sha256(canonicalJson(bundle), true);
  const raw = await masterRequest('/internal/abdm/shared/fhir/validate', {
    method: 'POST',
    body: externalRequestBody(bundle, expectedProfile, bundleHash),
    timeoutMs: abdmConfig.sharedServiceTimeoutMs
  });
  return { raw, bundleHash };
}

async function externalValidation(bundle, expectedProfile, provider = abdmConfig.fhirProvider) {
  let response;
  if (provider === 'master') response = await masterExternalValidation(bundle, expectedProfile);
  else if (provider === 'local') response = await localExternalValidation(bundle, expectedProfile);
  else throw new Error(`Unsupported FHIR provider: ${provider}`);

  if (!response) return null;
  const { raw, bundleHash } = response;
  const normalized = normalizeExternalResult(raw, {
    fhirVersion: abdmConfig.fhirR4Version,
    package: abdmConfig.fhirPackage,
    profile: expectedProfile,
    bundleHash
  });
  if (normalized.bundleHash && !timingSafeEqualText(normalized.bundleHash, bundleHash)) {
    const error = new Error('FHIR validator response hash does not match the submitted bundle');
    error.code = 'ABDM_FHIR_VALIDATOR_HASH_MISMATCH';
    throw error;
  }
  if (normalized.package && normalized.package !== abdmConfig.fhirPackage) {
    const error = new Error('FHIR validator used an unexpected implementation-guide package');
    error.code = 'ABDM_FHIR_VALIDATOR_PACKAGE_MISMATCH';
    throw error;
  }
  if (normalized.fhirVersion && normalized.fhirVersion !== abdmConfig.fhirR4Version) {
    const error = new Error('FHIR validator used an unexpected FHIR version');
    error.code = 'ABDM_FHIR_VALIDATOR_VERSION_MISMATCH';
    throw error;
  }
  return { ...normalized, provider };
}

async function validateBundle(bundle, options = {}) {
  const structural = structuralValidation(bundle);
  if (!structural.valid) return structural;

  const recognizedName = Object.values(PROFILE_NAMES).find(
    (profile) => profile.toUpperCase() === structural.recognizedProfile
  );
  const expectedProfile = options.expectedProfile || (
    recognizedName ? `${abdmConfig.fhirProfileBase}/${recognizedName}` : null
  );
  const provider = options.provider || abdmConfig.fhirProvider;
  const fallbackProvider = options.fallbackProvider === undefined
    ? abdmConfig.fhirFallbackProvider
    : options.fallbackProvider;

  if (options.external !== false && abdmConfig.requireExternalFhirValidation && !providerConfigured(provider)) {
    return {
      ...structural,
      valid: false,
      errors: [...structural.errors, `External NRCeS FHIR validation is required but provider ${provider} is not configured`],
      provider
    };
  }
  if (options.external !== false && providerConfigured(provider)) {
    let external;
    try {
      external = await externalValidation(bundle, expectedProfile, provider);
    } catch (error) {
      if (
        fallbackProvider &&
        fallbackProvider !== 'none' &&
        fallbackProvider !== provider &&
        providerConfigured(fallbackProvider) &&
        providerUnavailable(error)
      ) {
        external = await externalValidation(bundle, expectedProfile, fallbackProvider);
        external.fallbackFrom = provider;
      } else {
        throw error;
      }
    }
    return {
      ...structural,
      valid: external.valid,
      external,
      provider: external.provider,
      errors: external.errors,
      warnings: external.warnings,
      bundleHash: external.bundleHash || structural.bundleHash
    };
  }
  return structural;
}

async function assertValidBundle(bundle, options) {
  const result = await validateBundle(bundle, options);
  if (!result.valid) {
    const error = new Error('FHIR bundle validation failed');
    error.code = 'ABDM_FHIR_VALIDATION_FAILED';
    error.statusCode = 422;
    error.details = result;
    throw error;
  }
  return result;
}

async function localFhirHealth() {
  if (!abdmConfig.fhirValidatorUrl) return { configured: false, healthy: false, provider: 'local' };
  const rawHealth = abdmConfig.fhirValidatorHealthUrl || new URL('/validator/version', `${abdmConfig.fhirValidatorUrl.replace(/\/+$/, '')}/`).toString();
  try {
    const url = await safeInternalUrl(rawHealth, 'FHIR validator health URL');
    const response = await fetchFn(url, {
      method: 'GET',
      headers: internalServiceHeaders(),
      signal: AbortSignal.timeout(Math.min(abdmConfig.fhirValidatorTimeoutMs, 5000)),
      redirect: 'error'
    });
    const body = await readJsonResponse(response, 64 * 1024).catch(() => ({}));
    const healthy = response.ok && body.package !== false && (!body.package || body.package === abdmConfig.fhirPackage);
    return {
      configured: true,
      healthy,
      provider: 'local',
      location: 'HOSPITAL_LOCAL',
      package: body.package || abdmConfig.fhirPackage,
      fhirVersion: body.fhirVersion || abdmConfig.fhirR4Version,
      checkedAt: new Date().toISOString(),
      errorCode: healthy ? undefined : 'ABDM_FHIR_VALIDATOR_UNHEALTHY'
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      provider: 'local',
      location: 'HOSPITAL_LOCAL',
      checkedAt: new Date().toISOString(),
      errorCode: error.code || 'ABDM_FHIR_VALIDATOR_UNREACHABLE'
    };
  }
}

async function masterFhirHealth() {
  if (!abdmConfig.masterUrl) return { configured: false, healthy: false, provider: 'master', location: 'MEDIQLIQ_MASTER' };
  try {
    const response = await masterRequest('/internal/abdm/shared/health', {
      method: 'GET',
      timeoutMs: Math.min(abdmConfig.sharedServiceTimeoutMs, 5000)
    });
    return {
      ...(response?.services?.fhirValidator || {}),
      configured: response?.services?.fhirValidator?.configured !== false,
      healthy: response?.services?.fhirValidator?.healthy === true,
      provider: 'master',
      location: 'MEDIQLIQ_MASTER'
    };
  } catch (error) {
    return {
      configured: true,
      healthy: false,
      provider: 'master',
      location: 'MEDIQLIQ_MASTER',
      checkedAt: new Date().toISOString(),
      errorCode: error.code || 'ABDM_MASTER_SHARED_FHIR_UNREACHABLE'
    };
  }
}

async function checkFhirValidatorHealth(provider = abdmConfig.fhirProvider) {
  const primary = provider === 'local' ? await localFhirHealth() : await masterFhirHealth();
  const fallbackProvider = abdmConfig.fhirFallbackProvider;
  if (!fallbackProvider || fallbackProvider === 'none' || fallbackProvider === provider) return primary;
  const fallback = fallbackProvider === 'local' ? await localFhirHealth() : await masterFhirHealth();
  return { ...primary, fallback };
}

module.exports = {
  DOCUMENT_BUNDLE_PROFILE,
  PROFILE_REQUIREMENTS,
  structuralValidation,
  externalRequestBody,
  normalizeExternalResult,
  externalValidation,
  providerConfigured,
  providerUnavailable,
  validateBundle,
  assertValidBundle,
  checkFhirValidatorHealth
};
