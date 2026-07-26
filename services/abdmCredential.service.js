const AbdmCredential = require('../models/AbdmCredential');
const { encryptJson, decryptJson } = require('./abdmVault.service');

function normalizeSession(tokens = {}) {
  const accessToken = tokens.token || tokens.accessToken || tokens.xToken;
  const refreshToken = tokens.refreshToken;
  const expiresIn = Number(tokens.expiresIn || 1800);
  const refreshExpiresIn = Number(tokens.refreshExpiresIn || 0);
  const accessExpiresAt = new Date(
    Date.now() + Math.max(expiresIn - 60, 60) * 1000
  );
  const refreshExpiresAt = refreshExpiresIn
    ? new Date(Date.now() + refreshExpiresIn * 1000)
    : accessExpiresAt;

  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    scopes: tokens.scopes || tokens.scope || []
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
      purgeAt: session.refreshExpiresAt,
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

async function getActiveAccessToken(patientId) {
  const session = await getPatientSession(patientId);
  if (
    !session?.accessToken ||
    !session.accessExpiresAt ||
    new Date(session.accessExpiresAt).getTime() <= Date.now()
  ) {
    const error = new Error(
      'ABHA user token is missing or expired. Verify/login the ABHA again.'
    );
    error.statusCode = 409;
    throw error;
  }
  return session.accessToken;
}

async function clearPatientSession(patientId) {
  await AbdmCredential.deleteOne({ patientId });
}

module.exports = {
  normalizeSession,
  storePatientSession,
  getPatientSession,
  getActiveAccessToken,
  clearPatientSession
};
