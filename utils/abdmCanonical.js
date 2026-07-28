const crypto = require('crypto');

function normalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalize);

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      const normalized = normalize(value[key]);
      if (normalized !== undefined) result[key] = normalized;
      return result;
    }, {});
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function sha256(value, prefix = false) {
  const input = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  const digest = crypto.createHash('sha256').update(input).digest('hex');
  return prefix ? `sha256:${digest}` : digest;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { normalize, canonicalJson, sha256, timingSafeEqualText };
