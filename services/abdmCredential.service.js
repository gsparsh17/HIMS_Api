const AbdmCredential = require('../models/AbdmCredential');
const { encryptJson, decryptJson } = require('./abdmVault.service');

const ACCESS_TOKEN_FALLBACK_SECONDS = 1800;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

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
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
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
  const rawExpiry = jwtExpiry && durationExpiry
    ? Math.min(jwtExpiry, durationExpiry)
    : jwtExpiry || durationExpiry;

  if (!rawExpiry) return null;
  return new Date(Math.max(now, rawExpiry - TOKEN_EXPIRY_SKEW_MS));
}

function normalizeSession(tokens = {}, now = Date.now()) {
  const accessToken = tokens.token || tokens.accessToken || tokens.xToken;
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

function sessionStatusFromDates({ accessExpiresAt, refreshExpiresAt } = {}, now = Date.now()) {
  const accessExpiry = accessExpiresAt ? new Date(accessExpiresAt) : null;
  const refreshExpiry = refreshExpiresAt ? new Date(refreshExpiresAt) : null;
  const accessActive = accessExpiry && !Number.isNaN(accessExpiry.getTime()) && accessExpiry.getTime() > now;
  const refreshActive = refreshExpiry && !Number.isNaN(refreshExpiry.getTime()) && refreshExpiry.getTime() > now;

  return {
    status: accessActive ? 'ACTIVE' : 'REAUTH_REQUIRED',
    reason: accessActive ? null : accessExpiry ? 'ACCESS_TOKEN_EXPIRED' : 'ACCESS_TOKEN_MISSING',
    accessExpiresAt: accessExpiry,
    refreshExpiresAt: refreshExpiry,
    hasUnexpiredRefreshToken: Boolean(refreshActive)
  };
}

async function storePatientSession({ patient, tokens, updatedBy }) {
  const session = normalizeSession(tokens);
  if (!session.accessToken) return null;

  const aad = `abdm-patient-session:${patient._id}`;
  const encryptedSession = encryptJson(
    {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken
    },
    aad
  );

  return AbdmCredential.findOneAndUpdate(
    { patientId: patient._id },
    {
      patientId: patient._id,
      hospitalId: patient.hospitalId,
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
}

async function getPatientSession(patientId) {
  const record = await AbdmCredential.findOne({ patientId }).select(
    '+encryptedSession +encryptedSession.ciphertext +encryptedSession.iv +encryptedSession.tag'
  );
  if (!record) return null;

  const session = decryptJson(
    record.encryptedSession,
    `abdm-patient-session:${patientId}`
  );
  return {
    ...session,
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

function reauthenticationRequiredError(status) {
  const error = new Error(
    'The ABHA login session has expired. Verify the existing ABHA with OTP again, then retry the QR or card.'
  );
  error.statusCode = 409;
  error.code = 'ABHA_REAUTH_REQUIRED';
  error.details = {
    reason: status?.reason || 'ACCESS_TOKEN_EXPIRED',
    accessExpiresAt: status?.accessExpiresAt || null,
    refreshExpiresAt: status?.refreshExpiresAt || null
  };
  return error;
}

async function getActiveAccessToken(patientId) {
  const session = await getPatientSession(patientId);
  const status = session
    ? sessionStatusFromDates(session)
    : {
        status: 'REAUTH_REQUIRED',
        reason: 'SESSION_MISSING',
        accessExpiresAt: null,
        refreshExpiresAt: null
      };

  if (!session?.accessToken || status.status !== 'ACTIVE') {
    throw reauthenticationRequiredError(status);
  }
  return session.accessToken;
}

async function clearPatientSession(patientId) {
  await AbdmCredential.deleteOne({ patientId });
}

module.exports = {
  normalizeSession,
  sessionStatusFromDates,
  storePatientSession,
  getPatientSession,
  getPatientSessionStatus,
  getActiveAccessToken,
  clearPatientSession
};
