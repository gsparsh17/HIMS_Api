const crypto = require('crypto');

const SALUTATIONS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'baby', 'master', 'shri', 'smt'
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token && !SALUTATIONS.has(token));
}

function patientName(patient = {}) {
  return [patient.first_name, patient.middle_name, patient.last_name]
    .filter(Boolean)
    .join(' ');
}

function profileName(profile = {}) {
  return (
    profile.name ||
    [profile.firstName, profile.middleName, profile.lastName]
      .filter(Boolean)
      .join(' ')
  );
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (!text || text.includes('*')) return null;
  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const date = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    if (
      date.getUTCFullYear() === Number(dmy[3]) &&
      date.getUTCMonth() === Number(dmy[2]) - 1 &&
      date.getUTCDate() === Number(dmy[1])
    ) {
      return date.toISOString().slice(0, 10);
    }
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function profileDob(profile = {}) {
  const direct = parseDate(profile.dob || profile.dateOfBirth);
  if (direct) return direct;
  const year = Number(String(profile.yearOfBirth || '').replace(/\D/g, ''));
  const monthText = String(profile.monthOfBirth || '');
  const dayText = String(profile.dayOfBirth || '');
  if (!year || monthText.includes('*') || dayText.includes('*')) return null;
  const month = Number(monthText || 1);
  const day = Number(dayText || 1);
  return parseDate(`${day}-${month}-${year}`);
}

function normalizeGender(value) {
  const normalized = normalizeText(value).toUpperCase();
  if (['M', 'MALE'].includes(normalized)) return 'M';
  if (['F', 'FEMALE'].includes(normalized)) return 'F';
  if (['O', 'OTHER', 'OTHERS', 'U', 'UNKNOWN'].includes(normalized)) return 'O';
  return null;
}

function fullMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}

function similarity(left, right) {
  const a = new Set(nameTokens(left));
  const b = new Set(nameTokens(right));
  if (!a.size || !b.size) return null;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function safeProfileFingerprint(profile = {}) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        name: normalizeText(profileName(profile)),
        dob: profileDob(profile),
        gender: normalizeGender(profile.gender),
        mobileLast4: fullMobile(profile.mobile || profile.phoneNumber)?.slice(-4),
        abhaNumber: String(profile.ABHANumber || profile.abhaNumber || '').replace(/\D/g, ''),
        abhaAddress: String(
          profile.preferredAbhaAddress ||
            profile.ABHAAddress ||
            (Array.isArray(profile.phrAddress) ? profile.phrAddress[0] : profile.abhaAddress) ||
            ''
        ).toLowerCase()
      })
    )
    .digest('hex');
}

function assessPatientIdentity(patient = {}, profile = {}) {
  const matchedFields = [];
  const mismatchedFields = [];
  const unavailableFields = [];

  const localDob = parseDate(patient.dob);
  const officialDob = profileDob(profile);
  if (localDob && officialDob) {
    (localDob === officialDob ? matchedFields : mismatchedFields).push('DOB');
  } else {
    unavailableFields.push('DOB');
  }

  const localGender = normalizeGender(patient.gender);
  const officialGender = normalizeGender(profile.gender);
  if (localGender && officialGender) {
    (localGender === officialGender ? matchedFields : mismatchedFields).push('GENDER');
  } else {
    unavailableFields.push('GENDER');
  }

  const localMobile = fullMobile(patient.phone);
  const officialMobile = fullMobile(profile.mobile || profile.phoneNumber);
  if (localMobile && officialMobile) {
    (localMobile === officialMobile ? matchedFields : mismatchedFields).push('MOBILE');
  } else {
    unavailableFields.push('MOBILE');
  }

  const nameScore = similarity(patientName(patient), profileName(profile));
  if (nameScore === null) {
    unavailableFields.push('NAME');
  } else if (nameScore >= 0.5) {
    matchedFields.push('NAME');
  } else {
    mismatchedFields.push('NAME');
  }

  const strongMatch = matchedFields.includes('DOB') || matchedFields.includes('MOBILE');
  const enoughEvidence = matchedFields.length >= 2 && strongMatch;
  const hardMismatch = mismatchedFields.some((field) =>
    ['DOB', 'GENDER', 'MOBILE'].includes(field)
  );
  const matched = !hardMismatch && !mismatchedFields.includes('NAME') && enoughEvidence;

  return {
    matched,
    score: Math.round(
      ((matchedFields.length / Math.max(matchedFields.length + mismatchedFields.length, 1)) * 100)
    ),
    matchedFields,
    mismatchedFields,
    unavailableFields,
    profileFingerprint: safeProfileFingerprint(profile)
  };
}

function identityMismatchError(assessment) {
  const error = new Error(
    'The verified ABDM profile does not match the selected local patient. Correct the local patient demographics or select the correct patient before linking this ABHA.'
  );
  error.statusCode = 409;
  error.code = 'ABHA_IDENTITY_MISMATCH';
  error.countAttempt = false;
  error.details = {
    matchedFields: assessment.matchedFields,
    mismatchedFields: assessment.mismatchedFields,
    unavailableFields: assessment.unavailableFields,
    score: assessment.score
  };
  return error;
}

function assertPatientIdentityMatch(patient, profile) {
  const assessment = assessPatientIdentity(patient, profile);
  if (!assessment.matched) throw identityMismatchError(assessment);
  return assessment;
}

module.exports = {
  assessPatientIdentity,
  assertPatientIdentityMatch,
  identityMismatchError,
  normalizeGender,
  parseDate,
  similarity
};
