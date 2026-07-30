const abdmConfig = require('../config/abdm.config');

function identifier(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return value.id || value.identifier || value.value || value.referenceNumber || value.careContextReference || null;
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function norm(value) {
  const result = identifier(value);
  return result === null ? null : String(result).trim().toLowerCase();
}

function purposeCode(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.code || value.id || value.value || null;
}

function subset(requested, allowed) {
  const allowedSet = new Set(asArray(allowed).map(norm).filter(Boolean));
  return asArray(requested).map(norm).filter(Boolean).every((value) => allowedSet.has(value));
}

function assertVerifiedScopeMatches(result, operation = {}, expected = {}) {
  const scope = result?.verifiedScope;
  const issues = [];
  const mismatch = (code, path, message) => issues.push({ code, path, message });
  if (!scope || typeof scope !== 'object') {
    mismatch('VERIFIED_SCOPE_MISSING', 'verifiedScope', 'Consent validator did not return verified claims');
  } else {
    const expectedConsentId = expected.consentId || operation.consentId;
    if (expectedConsentId && norm(scope.consentId) !== norm(expectedConsentId)) {
      mismatch('CONSENT_ID_MISMATCH', 'verifiedScope.consentId', 'Verified consent ID does not match');
    }
    const expectedPatient = expected.patientId || operation.patientId || operation.abhaAddress;
    if (expectedPatient && norm(scope.patientId) !== norm(expectedPatient)) {
      mismatch('CONSENT_PATIENT_MISMATCH', 'verifiedScope.patientId', 'Verified patient does not match');
    }
    const expectedHip = expected.hipId || operation.hipId;
    if (expectedHip && !subset([expectedHip], scope.hipIds)) {
      mismatch('CONSENT_HIP_MISMATCH', 'verifiedScope.hipIds', 'Verified HIP does not match');
    }
    if (operation.hipIds?.length && !subset(operation.hipIds, scope.hipIds)) {
      mismatch('CONSENT_HIP_MISMATCH', 'verifiedScope.hipIds', 'Verified HIP set does not cover the operation');
    }
    const expectedHiu = expected.hiuId || operation.hiuId;
    if (expectedHiu && norm(scope.hiuId) !== norm(expectedHiu)) {
      mismatch('CONSENT_HIU_MISMATCH', 'verifiedScope.hiuId', 'Verified HIU does not match');
    }
    if (operation.purpose && norm(purposeCode(scope.purpose)) !== norm(purposeCode(operation.purpose))) {
      mismatch('CONSENT_PURPOSE_MISMATCH', 'verifiedScope.purpose', 'Verified purpose does not match');
    }
    if (operation.hiTypes?.length && !subset(operation.hiTypes, scope.hiTypes)) {
      mismatch('CONSENT_HI_TYPE_NOT_AUTHORIZED', 'verifiedScope.hiTypes', 'Verified HI types do not cover the operation');
    }
    if (operation.careContextIds?.length && !subset(operation.careContextIds, scope.careContextIds)) {
      mismatch('CONSENT_CARE_CONTEXT_NOT_AUTHORIZED', 'verifiedScope.careContextIds', 'Verified care contexts do not cover the operation');
    }
    const consentFrom = scope.dateRange?.from ? new Date(scope.dateRange.from).getTime() : null;
    const consentTo = scope.dateRange?.to ? new Date(scope.dateRange.to).getTime() : null;
    const requestFrom = operation.dateRange?.from ? new Date(operation.dateRange.from).getTime() : null;
    const requestTo = operation.dateRange?.to ? new Date(operation.dateRange.to).getTime() : null;
    if (requestFrom && (!consentFrom || requestFrom < consentFrom)) {
      mismatch('CONSENT_DATE_RANGE_EXCEEDED', 'verifiedScope.dateRange.from', 'Verified date range does not cover the operation start');
    }
    if (requestTo && (!consentTo || requestTo > consentTo)) {
      mismatch('CONSENT_DATE_RANGE_EXCEEDED', 'verifiedScope.dateRange.to', 'Verified date range does not cover the operation end');
    }
    if (String(operation.type || '').toUpperCase() !== 'REGISTER_ARTEFACT' && String(result.lifecycleStatus || scope.status || '').toUpperCase() !== 'GRANTED') {
      mismatch('CONSENT_STATUS_INVALID', 'lifecycleStatus', 'Consent is not currently granted');
    }
  }
  if (!result?.trust?.algorithm) {
    mismatch('TRUST_EVIDENCE_MISSING', 'trust.algorithm', 'Consent validator did not return signing algorithm evidence');
  }
  if (abdmConfig.isProduction && (!result?.trust?.issuer || !result?.trust?.keyId)) {
    mismatch('TRUST_EVIDENCE_INCOMPLETE', 'trust', 'Production consent validation requires issuer and key ID evidence');
  }
  if (issues.length) {
    const error = new Error(issues[0].message);
    error.statusCode = 502;
    error.code = 'ABDM_CONSENT_VALIDATOR_SCOPE_INVALID';
    error.details = { issues };
    throw error;
  }
  return true;
}

module.exports = {
  identifier,
  asArray,
  norm,
  purposeCode,
  subset,
  assertVerifiedScopeMatches
};
