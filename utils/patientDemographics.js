const PHONE_PATTERN = /^[6-9]\d{9}$/;

function normalizeIndianPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function validateIndianPhone(value, field = 'phone') {
  const normalized = normalizeIndianPhone(value);
  if (!PHONE_PATTERN.test(normalized)) {
    const error = new Error('Phone number must be a valid 10-digit Indian mobile number');
    error.statusCode = 400;
    error.code = 'INVALID_PHONE';
    error.details = { field, expected: '10 digits beginning with 6-9' };
    throw error;
  }
  return normalized;
}

function clampInteger(value, min, max, field) {
  const parsed = Number(value || 0);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${field} must be between ${min} and ${max}`);
    error.statusCode = 400;
    error.code = 'INVALID_AGE';
    error.details = { field, min, max };
    throw error;
  }
  return parsed;
}

function estimatedDobFromAge({ years = 0, months = 0, days = 0, ageAsOf = new Date() } = {}) {
  const y = clampInteger(years, 0, 130, 'ageYears');
  const m = clampInteger(months, 0, 11, 'ageMonths');
  const d = clampInteger(days, 0, 30, 'ageDays');
  const asOf = new Date(ageAsOf);
  if (Number.isNaN(asOf.getTime())) throw new Error('Invalid ageAsOf date');
  const dob = new Date(asOf);
  dob.setDate(dob.getDate() - d);
  dob.setMonth(dob.getMonth() - m);
  dob.setFullYear(dob.getFullYear() - y);
  dob.setHours(0, 0, 0, 0);
  return { dob, years: y, months: m, days: d, ageAsOf: asOf };
}

function normalizePatientDemographics(payload = {}) {
  const normalized = { ...payload };
  normalized.phone = validateIndianPhone(payload.phone);
  normalized.normalizedPhone = normalized.phone;

  if (payload.emergency_phone) {
    normalized.emergency_phone = normalizeIndianPhone(payload.emergency_phone);
  }

  const source = String(payload.ageEntrySource || (payload.dob ? 'DOB' : 'AGE')).toUpperCase();
  if (source === 'AGE') {
    const derived = estimatedDobFromAge({
      years: payload.enteredAgeYears,
      months: payload.enteredAgeMonths,
      days: payload.enteredAgeDays,
      ageAsOf: payload.ageAsOf || new Date()
    });
    normalized.dob = derived.dob;
    normalized.dobPrecision = 'ESTIMATED';
    normalized.ageEntrySource = 'AGE';
    normalized.enteredAgeYears = derived.years;
    normalized.enteredAgeMonths = derived.months;
    normalized.enteredAgeDays = derived.days;
    normalized.ageAsOf = derived.ageAsOf;
  } else {
    const dob = new Date(payload.dob);
    if (Number.isNaN(dob.getTime()) || dob > new Date()) {
      const error = new Error('A valid date of birth is required');
      error.statusCode = 400;
      error.code = 'INVALID_DOB';
      error.details = { field: 'dob' };
      throw error;
    }
    normalized.dob = dob;
    normalized.dobPrecision = 'EXACT';
    normalized.ageEntrySource = 'DOB';
    normalized.ageAsOf = payload.ageAsOf ? new Date(payload.ageAsOf) : new Date();
  }
  return normalized;
}

module.exports = {
  normalizeIndianPhone,
  validateIndianPhone,
  estimatedDobFromAge,
  normalizePatientDemographics
};
