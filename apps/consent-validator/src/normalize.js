function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function identifier(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  return firstDefined(
    value.id,
    value.identifier,
    value.referenceNumber,
    value.careContextReference,
    value.value
  ) || null;
}

function parseDate(value, field, errors, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ code: 'FIELD_REQUIRED', path: field, message: `${field} is required` });
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push({ code: 'INVALID_DATE', path: field, message: `${field} is not a valid date` });
    return null;
  }
  return date;
}

function normalizePurpose(value) {
  if (!value) return null;
  if (typeof value === 'string') return { code: value, text: value };
  return {
    code: firstDefined(value.code, value.id, value.value) || null,
    text: firstDefined(value.text, value.display, value.name) || null,
    refUri: firstDefined(value.refUri, value.system, value.uri) || null
  };
}

function normalizeFrequency(value, errors) {
  if (!value) return null;
  const unit = String(value.unit || '').trim().toUpperCase();
  const intervalValue = Number(value.value);
  const repeats = Number(firstDefined(value.repeats, value.repeat, 0));
  if (!['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'].includes(unit)) {
    errors.push({ code: 'FREQUENCY_UNIT_INVALID', path: 'permission.frequency.unit', message: 'Unsupported consent frequency unit' });
  }
  if (!Number.isInteger(intervalValue) || intervalValue < 1) {
    errors.push({ code: 'FREQUENCY_VALUE_INVALID', path: 'permission.frequency.value', message: 'Frequency value must be a positive integer' });
  }
  if (!Number.isInteger(repeats) || repeats < 0) {
    errors.push({ code: 'FREQUENCY_REPEATS_INVALID', path: 'permission.frequency.repeats', message: 'Frequency repeats must be a non-negative integer' });
  }
  return { unit, value: intervalValue, repeats };
}

function stripProofFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripProofFields);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['signature', 'proof', 'jws', 'signedConsent'].includes(key)) continue;
    output[key] = stripProofFields(item);
  }
  return output;
}

function consentRoot(input = {}) {
  return (
    input.consentDetail ||
    input.consentArtefact ||
    input.consent ||
    input.notification?.consentDetail ||
    input.notification?.consentArtefact ||
    input.notification ||
    input
  );
}

function normalizeConsent(input = {}) {
  const root = consentRoot(input);
  const permission = root.permission || input.permission || {};
  const errors = [];
  const status = String(
    firstDefined(root.status, input.status, input.notification?.status, 'PENDING')
  ).toUpperCase();
  const dateRange = permission.dateRange || root.dateRange || input.dateRange || {};
  const careContexts = asArray(
    firstDefined(
      permission.careContexts,
      root.careContexts,
      input.careContexts,
      input.notification?.careContexts
    )
  )
    .map(identifier)
    .filter(Boolean);
  const hipIds = asArray(firstDefined(root.hips, input.hips, root.hip, input.hip))
    .map(identifier)
    .filter(Boolean);
  const hiTypes = asArray(
    firstDefined(permission.hiTypes, root.hiTypes, input.hiTypes)
  )
    .map((item) => String(item).trim())
    .filter(Boolean);
  const patientId = identifier(firstDefined(root.patient, input.patient)) || firstDefined(root.abhaAddress, input.abhaAddress) || null;
  const consentId = firstDefined(root.id, root.consentId, input.consentId, input.notification?.consentId);
  const purpose = normalizePurpose(firstDefined(permission.purpose, root.purpose, input.purpose));
  const validFrom = parseDate(
    firstDefined(permission.validFrom, root.validFrom, input.validFrom, root.createdAt),
    'validFrom',
    errors,
    false
  );
  const expiresAt = parseDate(
    firstDefined(
      permission.permissionExpiry,
      root.expiresAt,
      input.expiresAt,
      permission.dataEraseAt
    ),
    'expiresAt',
    errors,
    true
  );
  const dataEraseAt = parseDate(
    firstDefined(permission.dataEraseAt, root.dataEraseAt, input.dataEraseAt, expiresAt),
    'permission.dataEraseAt',
    errors,
    true
  );
  const from = parseDate(dateRange.from, 'permission.dateRange.from', errors, true);
  const to = parseDate(dateRange.to, 'permission.dateRange.to', errors, true);
  const frequency = normalizeFrequency(permission.frequency, errors);

  if (!consentId) errors.push({ code: 'CONSENT_ID_MISSING', path: 'consent.id', message: 'Consent identifier is missing' });
  if (!patientId) errors.push({ code: 'PATIENT_MISSING', path: 'patient.id', message: 'Consent patient identity is missing' });
  if (!hipIds.length) errors.push({ code: 'HIP_MISSING', path: 'hip.id', message: 'Consent HIP identity is missing' });
  const hiuId = identifier(firstDefined(root.hiu, input.hiu));
  if (!hiuId) errors.push({ code: 'HIU_MISSING', path: 'hiu.id', message: 'Consent HIU identity is missing' });
  if (!purpose?.code) errors.push({ code: 'PURPOSE_MISSING', path: 'purpose.code', message: 'Consent purpose is missing' });
  if (!hiTypes.length) errors.push({ code: 'HI_TYPES_MISSING', path: 'permission.hiTypes', message: 'Consent HI types are missing' });
  if (from && to && from.getTime() > to.getTime()) {
    errors.push({ code: 'DATE_RANGE_INVALID', path: 'permission.dateRange', message: 'Consent date range start is after end' });
  }
  if (validFrom && expiresAt && validFrom.getTime() >= expiresAt.getTime()) {
    errors.push({ code: 'VALIDITY_RANGE_INVALID', path: 'validFrom', message: 'Consent validity start must be before expiry' });
  }

  return {
    valid: errors.length === 0,
    errors,
    root: stripProofFields(root),
    claims: {
      consentId: consentId ? String(consentId) : null,
      status,
      patientId: patientId ? String(patientId).toLowerCase() : null,
      hipIds: Array.from(new Set(hipIds.map(String))),
      hiuId: hiuId ? String(hiuId) : null,
      purpose,
      hiTypes: Array.from(new Set(hiTypes)),
      careContextIds: Array.from(new Set(careContexts.map(String))),
      dateRange: {
        from: from?.toISOString() || null,
        to: to?.toISOString() || null
      },
      validFrom: validFrom?.toISOString() || null,
      expiresAt: expiresAt?.toISOString() || null,
      dataEraseAt: dataEraseAt?.toISOString() || null,
      frequency,
      accessMode: permission.accessMode || null,
      retention: permission.retention || null
    }
  };
}

module.exports = {
  firstDefined,
  asArray,
  identifier,
  normalizePurpose,
  normalizeConsent,
  stripProofFields,
  consentRoot
};
