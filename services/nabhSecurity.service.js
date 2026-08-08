'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return result;
}

function base32Decode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 value');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCode(secret, timestamp = Date.now(), stepSeconds = 30, digits = 6) {
  const counter = Math.floor(timestamp / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function verifyTotp(secret, candidate, { window = 1, timestamp = Date.now() } = {}) {
  const code = String(candidate || '').trim();
  if (!/^\d{6}$/.test(code)) return false;
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = totpCode(secret, timestamp + delta * 30000);
    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function passwordPolicyErrors(password, policy = {}) {
  const value = String(password || '');
  const errors = [];
  if (value.length < Number(policy.minLength || 10)) errors.push(`Minimum ${policy.minLength || 10} characters required`);
  if (policy.requireUppercase !== false && !/[A-Z]/.test(value)) errors.push('At least one uppercase character is required');
  if (policy.requireLowercase !== false && !/[a-z]/.test(value)) errors.push('At least one lowercase character is required');
  if (policy.requireNumbers !== false && !/\d/.test(value)) errors.push('At least one number is required');
  if (policy.requireSpecialChars !== false && !/[^A-Za-z0-9]/.test(value)) errors.push('At least one special character is required');
  return errors;
}

function createMfaChallenge(user) {
  const nonce = crypto.randomBytes(16).toString('hex');
  return require('jsonwebtoken').sign(
    { purpose: 'mfa_login', id: user._id, nonce },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

function verifyMfaChallenge(token) {
  const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
  if (decoded.purpose !== 'mfa_login') throw new Error('Invalid MFA challenge');
  return decoded;
}

function createSsoSignaturePayload({ email, issuer, audience, timestamp }) {
  return `${String(email).toLowerCase()}|${issuer || ''}|${audience || ''}|${timestamp}`;
}

function verifySsoAssertion(assertion, settings) {
  const secret = settings?.security?.sso?.assertionSecret || process.env.SSO_ASSERTION_SECRET;
  if (!secret) return { valid: false, reason: 'SSO assertion secret is not configured' };
  const { email, issuer, audience, timestamp, signature } = assertion || {};
  if (!email || !timestamp || !signature) return { valid: false, reason: 'Incomplete SSO assertion' };
  if (settings?.security?.sso?.issuer && issuer !== settings.security.sso.issuer) return { valid: false, reason: 'Issuer mismatch' };
  if (settings?.security?.sso?.audience && audience !== settings.security.sso.audience) return { valid: false, reason: 'Audience mismatch' };
  const age = Math.abs(Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(age) || age > 5 * 60 * 1000) return { valid: false, reason: 'SSO assertion expired' };
  const payload = createSsoSignaturePayload({ email, issuer, audience, timestamp });
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return {
    valid,
    ...(valid ? {} : { reason: 'Invalid SSO assertion signature' }),
    email: String(email).toLowerCase()
  };
}

module.exports = {
  generateTotpSecret,
  totpCode,
  verifyTotp,
  passwordPolicyErrors,
  createMfaChallenge,
  verifyMfaChallenge,
  verifySsoAssertion
};
