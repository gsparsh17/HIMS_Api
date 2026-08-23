'use strict';

const SENSITIVE_KEY_PATTERN = /(password|passcode|token|secret|authorization|cookie|otp|pin|api[_-]?key|refresh|access[_-]?token|aadhaar|aadhar|abha|mobile|phone|loginId|x-token)/i;
const ABHA_NUMBER_PATTERN = /\b(\d{2})[- ]?(\d{4})[- ]?(\d{4})[- ]?(\d{4})\b/g;
const AADHAAR_PATTERN = /\b(\d{4})[- ]?(\d{4})[- ]?(\d{4})\b/g;
const ABHA_ADDRESS_PATTERN = /\b([a-z0-9._-]{2,})@(abdm|sbx)\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OTP_LABEL_PATTERN = /\b(otp|one[- ]?time password|verification code)\s*[:=\-]?\s*(\d{4,8})\b/gi;
const PASSWORD_LABEL_PATTERN = /\b(password|passcode|pwd)\s*[:=]\s*([^\s,;]{4,})/gi;
const TOKEN_LABEL_PATTERN = /\b(access[_ -]?token|refresh[_ -]?token|x-token|api[_ -]?key|secret)\s*[:=]\s*([^\s,;]{8,})/gi;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskAbhaNumber(value) {
  const d = digits(value);
  if (d.length !== 14) return value ? '[MASKED_ABHA]' : value;
  return `XX-XXXX-XXXX-${d.slice(-4)}`;
}

function maskAadhaar(value) {
  const d = digits(value);
  if (d.length !== 12) return value ? '[MASKED_AADHAAR]' : value;
  return `XXXX-XXXX-${d.slice(-4)}`;
}

function maskAbhaAddress(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^([^@]+)@(abdm|sbx)$/i);
  if (!match) return value ? '[MASKED_ABHA_ADDRESS]' : value;
  const local = match[1];
  const suffix = match[2].toLowerCase();
  const visible = local.length <= 2 ? local[0] || '*' : `${local[0]}${'*'.repeat(Math.min(8, Math.max(3, local.length - 2)))}${local.slice(-1)}`;
  return `${visible}@${suffix}`;
}

function findingsInText(value) {
  const text = String(value || '');
  const findings = [];
  if (ABHA_NUMBER_PATTERN.test(text)) findings.push('ABHA_NUMBER');
  ABHA_NUMBER_PATTERN.lastIndex = 0;
  if (AADHAAR_PATTERN.test(text)) findings.push('AADHAAR');
  AADHAAR_PATTERN.lastIndex = 0;
  if (ABHA_ADDRESS_PATTERN.test(text)) findings.push('ABHA_ADDRESS');
  ABHA_ADDRESS_PATTERN.lastIndex = 0;
  if (OTP_LABEL_PATTERN.test(text)) findings.push('OTP');
  OTP_LABEL_PATTERN.lastIndex = 0;
  if (PASSWORD_LABEL_PATTERN.test(text)) findings.push('PASSWORD');
  PASSWORD_LABEL_PATTERN.lastIndex = 0;
  if (TOKEN_LABEL_PATTERN.test(text) || BEARER_PATTERN.test(text) || JWT_PATTERN.test(text)) findings.push('TOKEN_OR_SECRET');
  TOKEN_LABEL_PATTERN.lastIndex = 0;
  BEARER_PATTERN.lastIndex = 0;
  JWT_PATTERN.lastIndex = 0;
  return Array.from(new Set(findings));
}

function redactSensitiveText(value, { preserveIdentifierLast4 = true } = {}) {
  let text = String(value ?? '');
  text = text.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  text = text.replace(JWT_PATTERN, '[REDACTED_TOKEN]');
  text = text.replace(OTP_LABEL_PATTERN, '$1: [REDACTED_OTP]');
  text = text.replace(PASSWORD_LABEL_PATTERN, '$1=[REDACTED]');
  text = text.replace(TOKEN_LABEL_PATTERN, '$1=[REDACTED]');
  text = text.replace(ABHA_ADDRESS_PATTERN, (full) => maskAbhaAddress(full));
  text = text.replace(ABHA_NUMBER_PATTERN, (full) => preserveIdentifierLast4 ? maskAbhaNumber(full) : '[REDACTED_ABHA]');
  text = text.replace(AADHAAR_PATTERN, (full) => preserveIdentifierLast4 ? maskAadhaar(full) : '[REDACTED_AADHAAR]');
  return text;
}

function sanitizeFreeText(value, { mode = 'generic', max = 8000 } = {}) {
  const raw = String(value || '').trim().slice(0, max);
  const findings = findingsInText(raw);
  const hardReject = mode === 'support'
    ? findings.filter((item) => ['OTP', 'PASSWORD', 'TOKEN_OR_SECRET'].includes(item))
    : [];
  return {
    value: redactSensitiveText(raw),
    findings,
    rejected: hardReject.length > 0,
    rejectFindings: hardReject
  };
}

function cloneAndRedact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[MaxDepth]';
  if (Buffer.isBuffer(value)) return `[Buffer:${value.length}]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => cloneAndRedact(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    Object.entries(value).slice(0, 100).forEach(([key, item]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (/abha/i.test(key) && typeof item === 'string') {
          output[key] = item.includes('@') ? maskAbhaAddress(item) : maskAbhaNumber(item);
        } else if (/aadhaar|aadhar/i.test(key) && typeof item === 'string') {
          output[key] = maskAadhaar(item);
        } else {
          output[key] = '[REDACTED]';
        }
      } else {
        output[key] = cloneAndRedact(item, depth + 1);
      }
    });
    return output;
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(value);
    return redacted.length > 1000 ? `${redacted.slice(0, 1000)}...[truncated]` : redacted;
  }
  return value;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  maskAbhaNumber,
  maskAbhaAddress,
  maskAadhaar,
  findingsInText,
  redactSensitiveText,
  sanitizeFreeText,
  cloneAndRedact
};
