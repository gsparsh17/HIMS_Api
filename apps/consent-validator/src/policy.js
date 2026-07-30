const { config } = require('./config');
const { canonicalJson, sha256 } = require('./canonical');

function norm(value) {
  return value === undefined || value === null ? null : String(value).trim().toLowerCase();
}

function purposeCode(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.code || value.id || value.value || null;
}

function subset(requested = [], allowed = []) {
  const allowedSet = new Set((allowed || []).map(norm));
  return (requested || []).every((item) => allowedSet.has(norm(item)));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxUses(frequency) {
  if (!frequency) return null;
  if (config.repeatsMode === 'TOTAL') return Math.max(1, frequency.repeats);
  return frequency.repeats + 1;
}

function retentionUntil(claims, operation, now = new Date()) {
  const consentErase = parseDate(claims.dataEraseAt || claims.expiresAt);
  const requested = parseDate(operation.retentionUntil);
  const organizationMax = new Date(
    now.getTime() + config.maxRetentionDays * 24 * 60 * 60 * 1000
  );
  const candidates = [consentErase, requested, organizationMax].filter(Boolean);
  if (!candidates.length) return null;
  return new Date(Math.min(...candidates.map((item) => item.getTime())));
}

function evaluatePolicy({ claims, operation = {}, expected = {}, lifecycleStatus, now = new Date() }) {
  const issues = [];
  const deny = (code, path, message) => issues.push({ code, path, message });
  const type = String(operation.type || 'REGISTER_ARTEFACT').toUpperCase();
  const supportedTypes = new Set(['REGISTER_ARTEFACT', 'HIP_DISCLOSURE', 'HIU_DATA_REQUEST', 'HIU_IMPORT']);
  if (!supportedTypes.has(type)) {
    deny('OPERATION_TYPE_UNSUPPORTED', 'operation.type', `Unsupported consent operation type ${type}`);
  }
  const signedStatus = String(claims.status || '').toUpperCase();
  const lifecycleEventStatus = lifecycleStatus ? String(lifecycleStatus).toUpperCase() : null;
  const effectiveStatus = lifecycleEventStatus || signedStatus;

  const registrationOnly = type === 'REGISTER_ARTEFACT';
  // A local lifecycle event may make a consent more restrictive, but it must never
  // elevate an artefact whose cryptographically signed status is not GRANTED.
  if (!registrationOnly && signedStatus !== 'GRANTED') {
    deny(`CONSENT_${signedStatus || 'STATUS_INVALID'}`, 'status', `Signed consent status is ${signedStatus || 'missing'}`);
  }
  if (!registrationOnly && lifecycleEventStatus && lifecycleEventStatus !== 'GRANTED') {
    deny(`CONSENT_${lifecycleEventStatus}`, 'status', `Latest consent lifecycle status is ${lifecycleEventStatus}`);
  }
  const validFrom = parseDate(claims.validFrom);
  const expiresAt = parseDate(claims.expiresAt);
  if (!registrationOnly && validFrom && validFrom.getTime() > now.getTime()) {
    deny('CONSENT_NOT_YET_VALID', 'validFrom', 'Consent is not yet valid');
  }
  if (!registrationOnly && (!expiresAt || expiresAt.getTime() <= now.getTime())) {
    deny('CONSENT_EXPIRED', 'expiresAt', 'Consent has expired');
  }

  const expectedConsentId = expected.consentId || operation.consentId;
  if (expectedConsentId && norm(expectedConsentId) !== norm(claims.consentId)) {
    deny('CONSENT_ID_MISMATCH', 'consentId', 'Consent ID does not match the expected operation');
  }
  const expectedPatient = expected.patientId || operation.patientId || operation.abhaAddress;
  if (expectedPatient && norm(expectedPatient) !== norm(claims.patientId)) {
    deny('CONSENT_PATIENT_MISMATCH', 'patient.id', 'Consent patient does not match the expected patient');
  }
  const expectedHip = expected.hipId || operation.hipId;
  if (expectedHip && !claims.hipIds.map(norm).includes(norm(expectedHip))) {
    deny('CONSENT_HIP_MISMATCH', 'hip.id', 'Consent does not authorize the expected HIP');
  }
  const expectedHipIds = operation.hipIds || expected.hipIds || [];
  if (expectedHipIds.length && !subset(expectedHipIds, claims.hipIds)) {
    deny('CONSENT_HIP_MISMATCH', 'hips', 'Consent does not authorize all requested HIPs');
  }
  const expectedHiu = expected.hiuId || operation.hiuId;
  if (expectedHiu && norm(expectedHiu) !== norm(claims.hiuId)) {
    deny('CONSENT_HIU_MISMATCH', 'hiu.id', 'Consent HIU does not match the expected HIU');
  }

  const requestedPurpose = purposeCode(operation.purpose);
  if (requestedPurpose && norm(requestedPurpose) !== norm(claims.purpose?.code)) {
    deny('CONSENT_PURPOSE_MISMATCH', 'purpose.code', 'Requested purpose is outside consent scope');
  }
  if (operation.hiTypes?.length && !subset(operation.hiTypes, claims.hiTypes)) {
    deny('CONSENT_HI_TYPE_NOT_AUTHORIZED', 'hiTypes', 'One or more requested HI types are outside consent scope');
  }
  if (operation.careContextIds?.length && !subset(operation.careContextIds, claims.careContextIds)) {
    deny('CONSENT_CARE_CONTEXT_NOT_AUTHORIZED', 'careContexts', 'One or more care contexts are outside consent scope');
  }

  const consentFrom = parseDate(claims.dateRange?.from);
  const consentTo = parseDate(claims.dateRange?.to);
  const requestedFrom = parseDate(operation.dateRange?.from);
  const requestedTo = parseDate(operation.dateRange?.to);
  if (requestedFrom && consentFrom && requestedFrom.getTime() < consentFrom.getTime()) {
    deny('CONSENT_DATE_RANGE_EXCEEDED', 'dateRange.from', 'Requested start date is before consent scope');
  }
  if (requestedTo && consentTo && requestedTo.getTime() > consentTo.getTime()) {
    deny('CONSENT_DATE_RANGE_EXCEEDED', 'dateRange.to', 'Requested end date is after consent scope');
  }
  if (requestedFrom && requestedTo && requestedFrom.getTime() > requestedTo.getTime()) {
    deny('OPERATION_DATE_RANGE_INVALID', 'dateRange', 'Operation date range is invalid');
  }

  const consentErase = parseDate(claims.dataEraseAt || claims.expiresAt);
  const requestedRetention = parseDate(operation.retentionUntil);
  if (requestedRetention && consentErase && requestedRetention.getTime() > consentErase.getTime()) {
    deny('CONSENT_RETENTION_EXCEEDED', 'retentionUntil', 'Requested retention exceeds consent');
  }
  const organizationRetentionLimit = new Date(
    now.getTime() + config.maxRetentionDays * 24 * 60 * 60 * 1000
  );
  if (requestedRetention && requestedRetention.getTime() > organizationRetentionLimit.getTime()) {
    deny('CONSENT_RETENTION_POLICY_EXCEEDED', 'retentionUntil', 'Requested retention exceeds organization policy');
  }

  const strictTypes = new Set(['HIP_DISCLOSURE', 'HIU_DATA_REQUEST', 'HIU_IMPORT']);
  if (strictTypes.has(type)) {
    if (!operation.operationId && !operation.transactionId) {
      deny('OPERATION_ID_MISSING', 'operationId', 'A stable operation or transaction ID is required');
    }
    if (!operation.hospitalId && !expected.hospitalId) {
      deny('OPERATION_HOSPITAL_MISSING', 'hospitalId', 'The hospital/tenant operation boundary is required');
    }
    if (!operation.patientId && !operation.abhaAddress) {
      deny('OPERATION_PATIENT_MISSING', 'patientId', 'The operation patient is required');
    }
    if (!operation.hiuId) deny('OPERATION_HIU_MISSING', 'hiuId', 'The operation HIU is required');
    if (!operation.purpose) deny('OPERATION_PURPOSE_MISSING', 'purpose', 'The operation purpose is required');
    if (!Array.isArray(operation.hiTypes) || !operation.hiTypes.length) {
      deny('OPERATION_HI_TYPES_MISSING', 'hiTypes', 'The operation HI types are required');
    }
    if (!operation.dateRange?.from || !operation.dateRange?.to) {
      deny('OPERATION_DATE_RANGE_MISSING', 'dateRange', 'The operation date range is required');
    }
  }
  if (type === 'HIP_DISCLOSURE' || type === 'HIU_IMPORT') {
    if (!operation.hipId) deny('OPERATION_HIP_MISSING', 'hipId', 'The operation HIP is required');
  }
  if (type === 'HIP_DISCLOSURE' || type === 'HIU_IMPORT') {
    if (!Array.isArray(operation.careContextIds) || !operation.careContextIds.length) {
      deny('OPERATION_CARE_CONTEXTS_MISSING', 'careContextIds', 'Clinical record care contexts are required');
    }
  }
  if (type === 'HIP_DISCLOSURE') {
    if (!operation.packetHash) deny('OPERATION_PACKET_HASH_MISSING', 'packetHash', 'The approved packet hash is required');
  }
  if (type === 'HIU_IMPORT' && !operation.payloadHash) {
    deny('OPERATION_PAYLOAD_HASH_MISSING', 'payloadHash', 'The received encrypted payload hash is required');
  }

  const authorizationBinding = {
    type,
    consentId: claims.consentId,
    artefactScope: {
      patientId: claims.patientId,
      hipIds: claims.hipIds,
      hiuId: claims.hiuId,
      purpose: claims.purpose,
      hiTypes: claims.hiTypes,
      careContextIds: claims.careContextIds,
      dateRange: claims.dateRange
    },
    operation: {
      operationId: operation.operationId || operation.transactionId || null,
      hospitalId: operation.hospitalId || expected.hospitalId || null,
      patientId: operation.patientId || operation.abhaAddress || null,
      hipId: operation.hipId || null,
      hipIds: operation.hipIds || [],
      hiuId: operation.hiuId || null,
      purpose: operation.purpose || null,
      hiTypes: operation.hiTypes || [],
      careContextIds: operation.careContextIds || [],
      dateRange: operation.dateRange || null,
      packetHash: operation.packetHash || null,
      payloadHash: operation.payloadHash || null,
      retentionUntil: operation.retentionUntil || null
    }
  };

  return {
    decision: issues.length ? 'DENY' : 'PERMIT',
    issues,
    type,
    retentionUntil: retentionUntil(claims, operation, now)?.toISOString() || null,
    frequency: claims.frequency
      ? { ...claims.frequency, maxUses: maxUses(claims.frequency) }
      : null,
    authorizedOperationHash: sha256(canonicalJson(authorizationBinding))
  };
}

module.exports = { evaluatePolicy, maxUses, retentionUntil, subset, purposeCode };
