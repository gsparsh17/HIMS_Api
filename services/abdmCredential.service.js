const AbdmCredential = require('../models/AbdmCredential');
const Patient = require('../models/Patient');
const { encryptJson, decryptJson } = require('./abdmVault.service');

const ACCESS_TOKEN_FALLBACK_SECONDS = 1800;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const refreshLocks = new Map();

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
  existingSession
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
    { patientId },
    {
      patientId,
      hospitalId,
      encryptedSession,
      accessExpiresAt: session.accessExpiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
      purgeAt: session.refreshExpiresAt || session.accessExpiresAt,
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

async function storePatientSession({ patient, tokens, updatedBy }) {
  return persistPatientSession({
    patientId: patient._id,
    hospitalId: patient.hospitalId,
    tokens,
    updatedBy
  });
}

async function getCredentialRecord(patientId) {
  return AbdmCredential.findOne({ patientId }).select(
    '+encryptedSession +encryptedSession.ciphertext +encryptedSession.iv +encryptedSession.tag'
  );
}

async function getPatientSession(patientId) {
  const record = await getCredentialRecord(patientId);
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
    scopes: record.scopes
  };
}

async function getPatientSessionStatus(patientId) {
  const record = await AbdmCredential.findOne({ patientId })
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

function reauthenticationRequiredError(status, cause) {
  const error = new Error(
    'The ABDM profile session cannot be renewed. Authenticate the patient’s existing ABHA again before accessing the official profile, QR code or card.'
  );
  error.statusCode = 401;
  error.code = 'ABHA_REAUTH_REQUIRED';
  error.details = {
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
    throw reauthenticationRequiredError(status);
  }

  try {
    // Loaded lazily so the credential module remains straightforward to unit test
    // and to avoid sending refresh tokens anywhere except the server-side proxy.
    const { abdmGet } = require('./abdm.service');
    const data = await abdmGet('/v3/profile/account/request/token', {
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
      existingSession: session
    });
    return getPatientSession(patientId);
  } catch (error) {
    if ([400, 401, 403].includes(Number(error.statusCode))) {
      await clearPatientSession(patientId);
      throw reauthenticationRequiredError(status, error);
    }
    throw error;
  }
}

async function refreshPatientSession(patientId, { updatedBy } = {}) {
  const key = String(patientId);
  if (refreshLocks.has(key)) return refreshLocks.get(key);
  const promise = (async () => {
    const session = await getPatientSession(patientId);
    if (!session) throw reauthenticationRequiredError({ reason: 'SESSION_MISSING' });
    return performRefresh(patientId, session, updatedBy);
  })().finally(() => refreshLocks.delete(key));
  refreshLocks.set(key, promise);
  return promise;
}

async function getActiveAccessToken(patientId, options = {}) {
  const session = await getPatientSession(patientId);
  if (!session) {
    throw reauthenticationRequiredError({ reason: 'SESSION_MISSING' });
  }
  const status = sessionStatusFromDates(session);
  if (!options.forceRefresh && status.status === 'ACTIVE' && session.accessToken) {
    return session.accessToken;
  }
  if (status.hasUnexpiredRefreshToken && session.refreshToken) {
    const refreshed = await refreshPatientSession(patientId, options);
    if (refreshed?.accessToken) return refreshed.accessToken;
  }
  throw reauthenticationRequiredError({
    ...status,
    reason: session.accessToken ? status.reason : 'ACCESS_TOKEN_MISSING'
  });
}

async function withPatientAccessToken(patientId, operation, options = {}) {
  let token = await getActiveAccessToken(patientId, options);
  try {
    return await operation(token);
  } catch (error) {
    if (Number(error.statusCode) !== 401) throw error;
    token = await getActiveAccessToken(patientId, {
      ...options,
      forceRefresh: true
    });
    return operation(token);
  }
}

async function clearPatientSession(patientId) {
  await Promise.all([
    AbdmCredential.deleteOne({ patientId }),
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
  clearPatientSession
};
