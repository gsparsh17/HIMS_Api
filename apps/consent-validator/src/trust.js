const crypto = require('crypto');
const { config } = require('./config');
const { canonicalJson, sha256 } = require('./canonical');
const { stripProofFields, consentRoot } = require('./normalize');

function decodeJsonPart(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (_error) {
    const error = new Error(`Invalid ${label} JSON`);
    error.code = 'CONSENT_JWS_INVALID';
    throw error;
  }
}

function derEncodeLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let current = length;
  while (current > 0) {
    bytes.unshift(current & 0xff);
    current >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function trimInteger(buffer) {
  let index = 0;
  while (index < buffer.length - 1 && buffer[index] === 0) index += 1;
  let value = buffer.subarray(index);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return value;
}

function joseEcdsaToDer(signature) {
  if (signature.length % 2 !== 0) throw new Error('Invalid ECDSA signature size');
  const half = signature.length / 2;
  const r = trimInteger(signature.subarray(0, half));
  const s = trimInteger(signature.subarray(half));
  const body = Buffer.concat([
    Buffer.from([0x02]),
    derEncodeLength(r.length),
    r,
    Buffer.from([0x02]),
    derEncodeLength(s.length),
    s
  ]);
  return Buffer.concat([Buffer.from([0x30]), derEncodeLength(body.length), body]);
}

function algorithmOptions(alg) {
  const values = {
    RS256: { digest: 'RSA-SHA256' },
    RS512: { digest: 'RSA-SHA512' },
    PS256: {
      digest: 'RSA-SHA256',
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    },
    PS512: {
      digest: 'RSA-SHA512',
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 64
    },
    ES256: { digest: 'sha256', ecdsa: true },
    ES384: { digest: 'sha384', ecdsa: true }
  };
  return values[alg] || null;
}

function findCompactJws(request = {}) {
  const artefact = request.artefact || request;
  const root = consentRoot(artefact);
  const candidates = [
    request.proof?.jws,
    request.jws,
    artefact.proof?.jws,
    typeof artefact.signature === 'string' ? artefact.signature : artefact.signature?.jws,
    artefact.signedConsent,
    typeof root.signature === 'string' ? root.signature : root.signature?.jws,
    root.proof?.jws,
    root.signedConsent
  ];
  return candidates.find(
    (value) => typeof value === 'string' && value.split('.').length === 3
  ) || null;
}

function extractSignedConsent(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return (
    payload.consentDetail ||
    payload.consentArtefact ||
    payload.consent ||
    payload.notification?.consentDetail ||
    payload.notification?.consentArtefact ||
    payload.notification ||
    payload
  );
}

function audienceMatches(value, expected) {
  if (!expected.length) return true;
  const actual = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
  return expected.some((item) => actual.includes(item));
}

function validateJwks(body) {
  if (!Array.isArray(body?.keys) || !body.keys.length) {
    const error = new Error('Consent JWKS response contains no keys');
    error.code = 'CONSENT_JWKS_INVALID';
    throw error;
  }
  for (const key of body.keys) {
    if (!key || typeof key !== 'object' || !key.kty) {
      const error = new Error('Consent JWKS contains an invalid key');
      error.code = 'CONSENT_JWKS_INVALID';
      throw error;
    }
    if (key.use && key.use !== 'sig') {
      const error = new Error('Consent JWKS contains a non-signing key');
      error.code = 'CONSENT_JWKS_INVALID';
      throw error;
    }
  }
  return body;
}

class JwksStore {
  constructor() {
    this.cached = null;
    this.expiresAt = 0;
    this.lastError = null;
    this.lastRefreshAt = null;
  }

  async refresh() {
    if (config.pinnedJwks) {
      this.cached = validateJwks(config.pinnedJwks);
      this.expiresAt = Number.MAX_SAFE_INTEGER;
      this.lastRefreshAt = new Date();
      this.lastError = null;
      return this.cached;
    }
    if (!config.jwksUrl) throw new Error('JWKS source is not configured');
    let response;
    try {
      response = await fetch(config.jwksUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.trustFetchTimeoutMs),
        redirect: 'error'
      });
    } catch (cause) {
      this.lastError = cause.message;
      const error = new Error('Consent signing-key service is unavailable');
      error.code = 'CONSENT_TRUST_UNAVAILABLE';
      throw error;
    }
    if (!response.ok) {
      this.lastError = `HTTP ${response.status}`;
      const error = new Error('Consent signing-key service returned an error');
      error.code = 'CONSENT_TRUST_UNAVAILABLE';
      throw error;
    }
    const body = validateJwks(await response.json());
    this.cached = body;
    this.expiresAt = Date.now() + config.jwksCacheSeconds * 1000;
    this.lastRefreshAt = new Date();
    this.lastError = null;
    return body;
  }

  async get(kid, force = false) {
    if (force || !this.cached || Date.now() >= this.expiresAt) await this.refresh();
    const keys = this.cached?.keys || [];
    let key = kid ? keys.find((item) => item.kid === kid) : null;
    if (!key && !kid && keys.length === 1) key = keys[0];
    if (!key && !force && config.jwksUrl) return this.get(kid, true);
    if (!key) {
      const error = new Error('Consent signing key is unknown');
      error.code = 'CONSENT_SIGNING_KEY_UNKNOWN';
      throw error;
    }
    if (key.use && key.use !== 'sig') {
      const error = new Error('Consent key is not authorized for signatures');
      error.code = 'CONSENT_SIGNING_KEY_INVALID';
      throw error;
    }
    return key;
  }

  status() {
    return {
      configured: Boolean(config.pinnedJwks || config.jwksUrl),
      ready: Boolean(this.cached),
      source: config.pinnedJwks ? 'PINNED_JWKS' : config.jwksUrl ? 'REMOTE_JWKS' : 'NONE',
      lastRefreshAt: this.lastRefreshAt?.toISOString() || null,
      lastError: this.lastError
    };
  }
}

const jwksStore = new JwksStore();

function temporalChecks(payload) {
  const now = Math.floor(Date.now() / 1000);
  const skew = config.clockSkewSeconds;
  if (payload.exp !== undefined && Number(payload.exp) < now - skew) {
    const error = new Error('Consent signature has expired');
    error.code = 'CONSENT_SIGNATURE_EXPIRED';
    throw error;
  }
  if (payload.nbf !== undefined && Number(payload.nbf) > now + skew) {
    const error = new Error('Consent signature is not yet valid');
    error.code = 'CONSENT_SIGNATURE_NOT_YET_VALID';
    throw error;
  }
  if (payload.iat !== undefined && Number(payload.iat) > now + skew) {
    const error = new Error('Consent signature issued-at time is in the future');
    error.code = 'CONSENT_SIGNATURE_IAT_INVALID';
    throw error;
  }
}

function verifyPayloadBinding(requestArtefact, payload) {
  const unsigned = stripProofFields(consentRoot(requestArtefact));
  const signed = stripProofFields(extractSignedConsent(payload));
  const outerHash = sha256(canonicalJson(unsigned));
  const signedHash = sha256(canonicalJson(signed));
  if (outerHash !== signedHash) {
    const error = new Error('Signed consent payload does not match the supplied artefact');
    error.code = 'CONSENT_PAYLOAD_BINDING_FAILED';
    error.details = { outerHash, signedHash };
    throw error;
  }
  return { verifiedArtefact: signed, artefactHash: signedHash };
}

async function verifyConsentProof(request = {}) {
  const jws = findCompactJws(request);
  if (!jws) {
    if (config.allowUnsignedSandboxArtefacts && !config.isProduction) {
      const unsigned = stripProofFields(consentRoot(request.artefact || request));
      return {
        signatureVerified: false,
        integrityVerified: false,
        unsignedSandbox: true,
        verifiedArtefact: unsigned,
        artefactHash: sha256(canonicalJson(unsigned)),
        trust: { issuer: null, keyId: null, algorithm: 'UNSIGNED_SANDBOX' }
      };
    }
    const error = new Error('Consent artefact does not contain a compact JWS proof');
    error.code = 'CONSENT_SIGNATURE_MISSING';
    throw error;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = jws.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    const error = new Error('Consent compact JWS is incomplete');
    error.code = 'CONSENT_JWS_INVALID';
    throw error;
  }
  const header = decodeJsonPart(encodedHeader, 'JWS header');
  const payload = decodeJsonPart(encodedPayload, 'JWS payload');
  if (header.b64 === false || (Array.isArray(header.crit) && header.crit.length)) {
    const error = new Error('Detached/unencoded or critical JWS headers are not supported by this verifier profile');
    error.code = 'CONSENT_JWS_PROFILE_UNSUPPORTED';
    throw error;
  }
  if (!config.allowedAlgorithms.includes(header.alg)) {
    const error = new Error(`Consent JWS algorithm ${header.alg || 'missing'} is not allowed`);
    error.code = 'CONSENT_ALGORITHM_NOT_ALLOWED';
    throw error;
  }
  const options = algorithmOptions(header.alg);
  if (!options) {
    const error = new Error(`Consent JWS algorithm ${header.alg} is unsupported`);
    error.code = 'CONSENT_ALGORITHM_UNSUPPORTED';
    throw error;
  }
  const jwk = await jwksStore.get(header.kid);
  if (jwk.alg && jwk.alg !== header.alg) {
    const error = new Error('Consent JWS key algorithm does not match header');
    error.code = 'CONSENT_SIGNING_KEY_INVALID';
    throw error;
  }
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  let signature = Buffer.from(encodedSignature, 'base64url');
  if (options.ecdsa) signature = joseEcdsaToDer(signature);
  const verified = crypto.verify(
    options.digest,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    {
      key: publicKey,
      ...(options.padding ? { padding: options.padding } : {}),
      ...(options.saltLength ? { saltLength: options.saltLength } : {})
    },
    signature
  );
  if (!verified) {
    const error = new Error('Consent JWS signature is invalid');
    error.code = 'CONSENT_SIGNATURE_INVALID';
    throw error;
  }
  if (config.expectedIssuers.length && !config.expectedIssuers.includes(String(payload.iss || ''))) {
    const error = new Error('Consent JWS issuer is not trusted');
    error.code = 'CONSENT_ISSUER_INVALID';
    throw error;
  }
  if (!audienceMatches(payload.aud, config.expectedAudiences)) {
    const error = new Error('Consent JWS audience is not trusted');
    error.code = 'CONSENT_AUDIENCE_INVALID';
    throw error;
  }
  temporalChecks(payload);
  const binding = verifyPayloadBinding(request.artefact || request, payload);
  return {
    signatureVerified: true,
    integrityVerified: true,
    unsignedSandbox: false,
    verifiedArtefact: binding.verifiedArtefact,
    artefactHash: binding.artefactHash,
    trust: {
      issuer: payload.iss || null,
      audience: payload.aud || null,
      keyId: header.kid || jwk.kid || null,
      algorithm: header.alg,
      issuedAt: payload.iat ? new Date(Number(payload.iat) * 1000).toISOString() : null
    }
  };
}

module.exports = {
  JwksStore,
  jwksStore,
  findCompactJws,
  verifyConsentProof,
  joseEcdsaToDer,
  algorithmOptions
};
