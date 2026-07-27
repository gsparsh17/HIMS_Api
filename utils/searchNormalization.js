function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSearchText(value, maxLength = 100) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function caseInsensitiveRegex(value) {
  return new RegExp(escapeRegex(value), 'i');
}

function exactCaseInsensitiveRegex(value) {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

function flexibleDigitRegex(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  return new RegExp(digits.split('').map(escapeRegex).join('[^0-9]*'));
}

const ABHA_STATUS_ALIASES = {
  UNLINKED: ['UNLINKED', 'not_linked'],
  OTP_SENT: ['OTP_SENT', 'otp_sent'],
  VERIFICATION_PENDING: [
    'VERIFICATION_PENDING',
    'pending_verification',
    'manually_captured'
  ],
  VERIFIED: ['VERIFIED'],
  ACTIVE: ['ACTIVE'],
  DEACTIVATED: ['DEACTIVATED'],
  DELETED: ['DELETED']
};

function canonicalStatusKey(value) {
  const normalized = normalizeSearchText(value)
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

  if (normalized === 'NOT_LINKED') return 'UNLINKED';
  if (normalized === 'PENDING_VERIFICATION' || normalized === 'MANUALLY_CAPTURED') {
    return 'VERIFICATION_PENDING';
  }
  return normalized;
}

function abhaStatusFilter(value) {
  const key = canonicalStatusKey(value);
  const values = ABHA_STATUS_ALIASES[key] || [normalizeSearchText(value)];
  return { $in: values.filter(Boolean).map(exactCaseInsensitiveRegex) };
}

function patientSearchConditions(value) {
  const query = normalizeSearchText(value);
  if (!query) return [];

  const textRegex = caseInsensitiveRegex(query);
  const digitRegex = flexibleDigitRegex(query);
  const conditions = [
    { 'abha.address': textRegex },
    { first_name: textRegex },
    { middle_name: textRegex },
    { last_name: textRegex },
    { patientId: textRegex },
    { uhid: textRegex }
  ];

  if (digitRegex) {
    conditions.unshift(
      { 'abha.number': digitRegex },
      { phone: digitRegex }
    );
  } else {
    conditions.unshift({ 'abha.number': textRegex }, { phone: textRegex });
  }

  const nameTokens = query.split(' ').filter(Boolean);
  if (nameTokens.length > 1) {
    conditions.push({
      $and: nameTokens.map((token) => {
        const tokenRegex = caseInsensitiveRegex(token);
        return {
          $or: [
            { first_name: tokenRegex },
            { middle_name: tokenRegex },
            { last_name: tokenRegex }
          ]
        };
      })
    });
  }

  return conditions;
}

module.exports = {
  escapeRegex,
  normalizeSearchText,
  caseInsensitiveRegex,
  exactCaseInsensitiveRegex,
  flexibleDigitRegex,
  canonicalStatusKey,
  abhaStatusFilter,
  patientSearchConditions
};
