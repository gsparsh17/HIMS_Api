const crypto = require('crypto');
const LocalPlatformConfig = require('../models/LocalPlatformConfig');

// ============================================
// Encryption Key
// ============================================

function getKey() {
  const source = process.env.PLATFORM_LOCAL_SECRET_KEY || process.env.JWT_SECRET;

  if (!source) {
    throw new Error('JWT_SECRET or PLATFORM_LOCAL_SECRET_KEY is required for local connector storage');
  }

  return crypto.createHash('sha256').update(String(source)).digest();
}

// ============================================
// Encryption / Decryption
// ============================================

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const buffer = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ]);

  return {
    ciphertext: buffer.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt(value) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(value.iv, 'base64')
  );

  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

// ============================================
// Configuration Operations
// ============================================

async function load() {
  const row = await LocalPlatformConfig.findOne({ singletonKey: 'platform' }).lean();

  if (!row) {
    return null;
  }

  return {
    masterUrl: row.masterUrl,
    tenantCode: row.tenantCode,
    connectorKeyId: row.connectorKeyId,
    connectorSecret: decrypt(row.connectorSecretEncrypted),
    installationId: row.installationId,
    enrollmentId: row.enrollmentId,
    masterConfirmedAt: row.masterConfirmedAt,
    enrolledAt: row.enrolledAt
  };
}

async function save(data) {
  return LocalPlatformConfig.findOneAndUpdate(
    { singletonKey: 'platform' },
    {
      $set: {
        masterUrl: String(data.masterUrl || '').replace(/\/+$/, ''),
        tenantCode: String(data.tenantCode || '').toUpperCase(),
        connectorKeyId: data.connectorKeyId,
        connectorSecretEncrypted: encrypt(data.connectorSecret),
        installationId: data.installationId,
        enrollmentId: data.enrollmentId || undefined,
        enrolledAt: new Date()
      }
    },
    {
      upsert: true,
      new: true
    }
  );
}

async function markConfirmed() {
  return LocalPlatformConfig.findOneAndUpdate(
    { singletonKey: 'platform' },
    { $set: { masterConfirmedAt: new Date() } },
    { new: true }
  );
}

module.exports = {
  load,
  save,
  markConfirmed
};