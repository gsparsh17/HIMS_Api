const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

function canonicalRequest({ timestamp, requestId, method, path, body }) {
  const bodyHash = sha256(stableBody(body));
  return [timestamp, requestId, String(method || 'GET').toUpperCase(), path, bodyHash].join('\n');
}

function signRequest(secret, input) {
  const canonical = canonicalRequest(input);
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  sha256,
  stableBody,
  canonicalRequest,
  signRequest,
  safeEqual
};
