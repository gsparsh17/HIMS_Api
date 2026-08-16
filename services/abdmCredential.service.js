const AbdmCredential = require('../models/AbdmCredential');
const Patient = require('../models/Patient');
const { encryptJson, decryptJson } = require('./abdmVault.service');

const ACCESS_TOKEN_FALLBACK_SECONDS = 1800;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const refreshLocks = new Map();
const DEFAULT_SESSION_KIND = 'ABHA_PROFILE';

function positiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function jwtExpiresAt(token) {
  try {
    const payloadPart = String(token || '').split('.')[1];
    if (!payloadPart) return null;
    const payload = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8')
    );
    const expiresAt = Number(payload.exp) * 1000;
    return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
  } catch (_error) {
    return null;
  }
}

function tokenExpiresAt({ token, expiresIn, fallbackSeconds, now = Date.now() }) {
  const jwtExpiry = jwtExpiresAt(token);
  const durationSeconds = positiveNumber(expiresIn, fallbackSeconds);
  const durationExpiry = durationSeconds ? now + durationSeconds * 1000 : null;
  const rawExpiry =
    jwtExpiry && durationExpiry
      ? Math.min(jwtExpiry, durationExpiry)
      : jwtExpiry || durationExpiry;

  if (!rawExpiry) return null;
  return new Date(Math.max(now, rawExpiry - TOKEN_EXPIRY_SKEW_MS));
}

function normalizeSession(tokens = {}, now = Date.now()) {
  if (typeof tokens === 'string') tokens = { token: tokens };

  const accessToken =
    tokens.token || tokens.accessToken || tokens.xToken || tokens.access_token;
  const refreshToken = tokens.refreshToken || tokens.refresh_token;
  const accessExpiresAt = tokenExpiresAt({
    token: accessToken,
    expiresIn: positiveNumber(tokens.expiresIn, tokens.expires_in),
    fallbackSeconds: ACCESS_TOKEN_FALLBACK_SECONDS,
    now
  });
  const refreshExpiresAt = refreshToken
    ? tokenExpiresAt({
        token: refreshToken,
        expiresIn: positiveNumber(
          tokens.refreshExpiresIn,
          tokens.refresh_expires_in,
          tokens.refreshTokenExpiresIn
        ),
        fallbackSeconds: null,
        now
      })
    : accessExpiresAt;

  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt: refreshExpiresAt || accessExpiresAt,
    scopes: tokens.scopes || tokens.scope || []
  };
}

function extractTokenPayload(response) {
  const candidates = [
    response?.tokens,
    response?.data?.tokens,
    response?.result?.tokens,
    response?.response?.tokens,
    response?.payload?.tokens,
    response?.data,
    response?.result,
    response?.response,
    response?.payload,
    response
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') return { token: candidate };
    if (typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    const accessToken =
      candidate.token ||
      candidate.accessToken ||
      candidate.xToken ||
      candidate.access_token;
    if (accessToken) return candidate;
  }

  return null;
}

function tokenResponseShape(response) {
  const keys = (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [];

  return {
    topLevelKeys: keys(response),
    dataKeys: keys(response?.data),
    tokensKeys: keys(response?.tokens),
    nestedTokenKeys: keys(response?.data?.tokens)
  };
}

function sessionStatusFromDates(
  { accessExpiresAt, refreshExpiresAt } = {},
  now = Date.now()
) {
  const accessExpiry = accessExpiresAt ? new Date(accessExpiresAt) : null;
  const refreshExpiry = refreshExpiresAt ? new Date(refreshExpiresAt) : null;
  const accessActive =
    accessExpiry &&
    !Number.isNaN(accessExpiry.getTime()) &&
    accessExpiry.getTime() > now;
  const refreshActive =
    refreshExpiry &&
    !Number.isNaN(refreshExpiry.getTime()) &&
    refreshExpiry.getTime() > now;

  return {
    status: accessActive
      ? 'ACTIVE'
      : refreshActive
        ? 'REFRESH_AVAILABLE'
        : 'REAUTH_REQUIRED',
    reason: accessActive
      ? null
      : refreshActive
        ? 'ACCESS_TOKEN_EXPIRED'
        : refreshExpiry
          ? 'REFRESH_TOKEN_EXPIRED'
          : accessExpiry
            ? 'REFRESH_TOKEN_MISSING'
            : 'SESSION_MISSING',
    accessExpiresAt: accessExpiry,
    refreshExpiresAt: refreshExpiry,
    hasUnexpiredRefreshToken: Boolean(refreshActive)
  };
}

async function persistPatientSession({
  patientId,
  hospitalId,
  tokens,
  updatedBy,
  existingSession,
  sessionKind = DEFAULT_SESSION_KIND
}) {
  const mergedTokens = {
    ...tokens,
    refreshToken:
      tokens.refreshToken ||
      tokens.refresh_token ||
      existingSession?.refreshToken,
    refreshExpiresIn:
      tokens.refreshExpiresIn ||
      tokens.refresh_expires_in ||
      tokens.refreshTokenExpiresIn
  };
  const session = normalizeSession(mergedTokens);
  if (!session.accessToken) {
    throw new Error('ABDM token response did not include an access token');
  }

  if (
    !session.refreshExpiresAt &&
    existingSession?.refreshExpiresAt &&
    session.refreshToken === existingSession.refreshToken
  ) {
    session.refreshExpiresAt = new Date(existingSession.refreshExpiresAt);
  }

  const aad = `abdm-patient-session:${patientId}`;
  const encryptedSession = encryptJson(
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken
    },
    aad
  );

  const record = await AbdmCredential.findOneAndUpdate(
    { patientId, sessionKind },
    {
      patientId,
      hospitalId,
      encryptedSession,
      accessExpiresAt: session.accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
      purgeAt: session.refreshExpiresAt || session.accessExpiresAt,
      sessionKind,
      scopes: Array.isArray(session.scopes)
        ? session.scopes
        : String(session.scopes || '')
            .split(' ')
            .filter(Boolean),
      updatedBy
    },
    { upsert: true, new: true }
  );

  // Remove the pre-vault plaintext token location whenever a valid encrypted
  // credential is stored. This is idempotent and safe during gradual rollout.
  await Patient.updateOne({ _id: patientId }, { $unset: { 'abha.session': 1 } });
  return record;
}

async function storePatientSession({ patient, tokens, updatedBy, sessionKind = DEFAULT_SESSION_KIND }) {
  return persistPatientSession({
    patientId: patient._id,
    hospitalId: patient.hospitalId,
    tokens,
    updatedBy,
    sessionKind
  });
}

async function getCredentialRecord(patientId, sessionKind = DEFAULT_SESSION_KIND) {
  return AbdmCredential.findOne({ patientId, sessionKind }).select(
    '+encryptedSession +encryptedSession.ciphertext +encryptedSession.iv +encryptedSession.tag'
  );
}

async function getPatientSession(patientId, sessionKind = DEFAULT_SESSION_KIND) {
  const record = await getCredentialRecord(patientId, sessionKind);
  if (!record) return null;

  const session = decryptJson(
    record.encryptedSession,
    `abdm-patient-session:${patientId}`
  );
  return {
    ...session,
    hospitalId: record.hospitalId,
    accessExpiresAt: record.accessExpiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
    scopes: record.scopes,
    sessionKind: record.sessionKind || sessionKind
  };
}

async function getPatientSessionStatus(patientId, sessionKind = DEFAULT_SESSION_KIND) {
  const record = await AbdmCredential.findOne({ patientId, sessionKind })
    .select('accessExpiresAt refreshExpiresAt')
    .lean();
  if (!record) {
    return {
      status: 'REAUTH_REQUIRED',
      reason: 'SESSION_MISSING',
      accessExpiresAt: null,
      refreshExpiresAt: null,
      hasUnexpiredRefreshToken: false
    };
  }
  return sessionStatusFromDates(record);
}

function reauthenticationRequiredError(status, cause, sessionKind = DEFAULT_SESSION_KIND) {
  const message = sessionKind === 'PHR_APP'
    ? 'The ABDM PHR session cannot be renewed. Authenticate the patient in the PHR flow again before using patient-authenticated HIE-CM features.'
    : 'The ABDM ABHA Profile session cannot be renewed. Authenticate the patient’s existing ABHA again before accessing the official profile, QR code or card.';
  const error = new Error(message);
  error.statusCode = 401;
  error.code = 'ABHA_REAUTH_REQUIRED';
  error.details = {
    sessionKind,
    reason: status?.reason || 'REFRESH_TOKEN_UNUSABLE',
    accessExpiresAt: status?.accessExpiresAt || null,
    refreshExpiresAt: status?.refreshExpiresAt || null,
    ...(cause?.details ? { upstream: cause.details } : {})
  };
  return error;
}

async function performRefresh(patientId, session, updatedBy) {
  const status = sessionStatusFromDates(session);
  if (!session?.refreshToken || !status.hasUnexpiredRefreshToken) {
    throw reauthenticationRequiredError(status, null, session?.sessionKind || DEFAULT_SESSION_KIND);
  }

  try {
    // Loaded lazily so the credential module remains straightforward to unit test
    // and to avoid sending refresh tokens anywhere except the server-side proxy.
    const { abdmGet } = require('./abdm.service');
    const refreshPath = session.sessionKind === 'PHR_APP'
      ? '/v3/phr/app/login/profile/request/token'
      : '/v3/profile/account/request/token';
    const data = await abdmGet(refreshPath, {
      'R-token': `Bearer ${session.refreshToken}`
    });
    const tokens = extractTokenPayload(data);
    if (!tokens) {
      const error = new Error(
        'ABDM refresh response did not contain a patient access token'
      );
      error.statusCode = 502;
      error.code = 'ABDM_REFRESH_TOKEN_RESPONSE_INVALID';
      error.details = tokenResponseShape(data);
      throw error;
    }

    await persistPatientSession({
      patientId,
      hospitalId: session.hospitalId,
      tokens,
      updatedBy,
      existingSession: session,
      sessionKind: session.sessionKind || 'ABHA_PROFILE'
    });
    return getPatientSession(patientId, session.sessionKind || DEFAULT_SESSION_KIND);
  } catch (error) {
    if ([400, 401, 403].includes(Number(error.statusCode))) {
      await clearPatientSession(patientId, session.sessionKind || DEFAULT_SESSION_KIND);
      throw reauthenticationRequiredError(status, error, session.sessionKind || DEFAULT_SESSION_KIND);
    }
    throw error;
  }
}

async function refreshPatientSession(patientId, { updatedBy, sessionKind = DEFAULT_SESSION_KIND } = {}) {
  const key = `${patientId}:${sessionKind}`;
  if (refreshLocks.has(key)) return refreshLocks.get(key);
  const promise = (async () => {
    const session = await getPatientSession(patientId, sessionKind);
    if (!session) throw reauthenticationRequiredError({ reason: 'SESSION_MISSING' }, null, sessionKind);
    return performRefresh(patientId, session, updatedBy);
  })().finally(() => refreshLocks.delete(key));
  refreshLocks.set(key, promise);
  return promise;
}

async function getActiveAccessToken(patientId, options = {}) {
  const sessionKind = options.sessionKind || DEFAULT_SESSION_KIND;
  const session = await getPatientSession(patientId, sessionKind);
  if (!session) {
    throw reauthenticationRequiredError({ reason: 'SESSION_MISSING' }, null, sessionKind);
  }
  const status = sessionStatusFromDates(session);
  if (!options.forceRefresh && status.status === 'ACTIVE' && session.accessToken) {
    return session.accessToken;
  }
  if (status.hasUnexpiredRefreshToken && session.refreshToken) {
    const refreshed = await refreshPatientSession(patientId, { ...options, sessionKind });
    if (refreshed?.accessToken) return refreshed.accessToken;
  }
  throw reauthenticationRequiredError(
    {
      ...status,
      reason: session.accessToken ? status.reason : 'ACCESS_TOKEN_MISSING'
    },
    null,
    sessionKind
  );
}

function errorText(error) {
  const values = [
    error?.message,
    error?.code,
    error?.details?.message,
    error?.details?.error,
    error?.details?.error?.message,
    error?.details?.code
  ];
  try {
    if (error?.details) values.push(JSON.stringify(error.details));
  } catch (_error) {
    // Ignore non-serializable upstream details.
  }
  return values.filter(Boolean).join(' ').toLowerCase();
}

function isPatientAccessTokenRejected(error) {
  const statusCode = Number(error?.statusCode);
  if (![400, 401, 403].includes(statusCode)) return false;
  if (statusCode === 401) return true;

  const text = errorText(error);
  return (
    /invalid\s*x[- ]?token/.test(text) ||
    /invalid\s*x[- ]?auth[- ]?token/.test(text) ||
    /x[- ]?token\s*(?:is\s*)?(?:invalid|expired|missing)/.test(text) ||
    /x[- ]?auth[- ]?token\s*(?:is\s*)?(?:invalid|expired|missing)/.test(text) ||
    /(?:expired|invalid)\s*(?:patient\s*)?(?:access\s*)?token/.test(text)
  );
}

async function withPatientAccessToken(patientId, operation, options = {}) {
  const sessionKind = options.sessionKind || DEFAULT_SESSION_KIND;
  let token = await getActiveAccessToken(patientId, { ...options, sessionKind });
  try {
    return await operation(token);
  } catch (error) {
    // ABHA profile APIs may report an expired/rejected X-token as HTTP 400
    // (for example, "Invalid X-token") instead of HTTP 401. Refresh only
    // for token-specific 400/401/403 responses; do not retry ordinary 400
    // request-validation failures.
    if (!isPatientAccessTokenRejected(error)) throw error;

    token = await getActiveAccessToken(patientId, {
      ...options,
      forceRefresh: true,
      sessionKind
    });
    try {
      return await operation(token);
    } catch (retryError) {
      if (!isPatientAccessTokenRejected(retryError)) throw retryError;
      await clearPatientSession(patientId, sessionKind).catch(() => {});
      throw reauthenticationRequiredError(
        { reason: 'REFRESHED_ACCESS_TOKEN_REJECTED' },
        retryError,
        sessionKind
      );
    }
  }
}

async function clearPatientSession(patientId, sessionKind = DEFAULT_SESSION_KIND) {
  await Promise.all([
    AbdmCredential.deleteOne({ patientId, sessionKind }),
    Patient.updateOne({ _id: patientId }, { $unset: { 'abha.session': 1 } })
  ]);
}

async function clearAllPatientSessions(patientId) {
  await Promise.all([
    AbdmCredential.deleteMany({ patientId }),
    Patient.updateOne({ _id: patientId }, { $unset: { 'abha.session': 1 } })
  ]);
}

module.exports = {
  extractTokenPayload,
  normalizeSession,
  sessionStatusFromDates,
  storePatientSession,
  getPatientSession,
  getPatientSessionStatus,
  refreshPatientSession,
  getActiveAccessToken,
  withPatientAccessToken,
  isPatientAccessTokenRejected,
  clearPatientSession,
  clearAllPatientSessions
};
