const crypto = require('crypto');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashIdentifier(value, pepper = '') {
  if (value === undefined || value === null || value === '') return null;
  return sha256(`${pepper}:${String(value).trim().toLowerCase()}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { canonicalJson, sha256, hashIdentifier, safeEqual };
