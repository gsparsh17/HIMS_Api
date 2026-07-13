const dns = require('dns').promises;
const net = require('net');

function normalizeHosts(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname, allowedHosts) {
  if (!allowedHosts.length) return true;
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host !== suffix.slice(1);
    }
    return host === allowed;
  });
}

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0];
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function assertSafeOutboundUrl(rawUrl, options = {}) {
  const {
    label = 'Outbound URL',
    allowedHosts = [],
    requireHttps = true,
    allowPrivate = false
  } = options;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new Error(`${label} is invalid`);
  }

  if (requireHttps && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error(`${label} uses an unsupported protocol`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  if (!hostAllowed(parsed.hostname, normalizeHosts(allowedHosts))) {
    throw new Error(`${label} host is not in the configured allow-list`);
  }

  const resolved = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!resolved.length) throw new Error(`${label} host did not resolve`);
  if (!allowPrivate && resolved.some((item) => isPrivateAddress(item.address))) {
    throw new Error(`${label} resolves to a private, loopback, link-local, or reserved network`);
  }

  return parsed.toString();
}

module.exports = { assertSafeOutboundUrl, normalizeHosts, isPrivateAddress };
