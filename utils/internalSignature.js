const crypto = require('crypto');

function canonicalJsonValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Cannot canonicalize an invalid Date');
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonicalJsonValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalJson(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return canonicalJsonValue(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableBody(body) {
  return canonicalJson(body);
}

function canonicalRequest({ timestamp, requestId, method, path, body }) {
  return [
    timestamp,
    requestId,
    String(method || 'GET').toUpperCase(),
    path,
    sha256(stableBody(body))
  ].join('\n');
}

function signRequest(secret, input) {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalRequest(input))
    .digest('hex');
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ''));
  const right = Buffer.from(String(rightValue || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  canonicalJson,
  sha256,
  stableBody,
  canonicalRequest,
  signRequest,
  safeEqual
};
