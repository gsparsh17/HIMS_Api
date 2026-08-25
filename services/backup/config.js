const path = require('path');

const BACKUP_DIR = path.resolve(
  process.env.HIMS_BACKUP_DIR || process.env.MONGODB_BACKUP_DIR || path.join(process.cwd(), 'backups')
);
const TEMP_DIR = path.join(BACKUP_DIR, 'temp');

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase() === 'true';
}

function listEnv(name, fallback = []) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  return [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

module.exports = {
  BACKUP_DIR,
  TEMP_DIR,
  backupEnabled: () => boolEnv('BACKUP_ENABLED', true),
  incrementalEnabled: () => boolEnv('BACKUP_INCREMENTAL_ENABLED', true),
  fullEnabled: () => boolEnv('BACKUP_FULL_ENABLED', true),
  incrementalFallbackToFull: () => boolEnv('BACKUP_INCREMENTAL_FALLBACK_TO_FULL', false),
  providers: () => listEnv('BACKUP_STORAGE_PROVIDERS', ['local']),
  requiredProviders: () => listEnv('BACKUP_REQUIRED_TARGETS', listEnv('BACKUP_STORAGE_PROVIDERS', ['local'])),
  localRetentionDays: () => Math.max(1, Number(process.env.BACKUP_LOCAL_RETENTION_DAYS || process.env.BACKUP_RETENTION_DAYS || 30)),
  incrementalRetentionDays: () => Math.max(1, Number(process.env.BACKUP_INCREMENTAL_RETENTION_DAYS || 90)),
  fullRetentionDays: () => Math.max(1, Number(process.env.BACKUP_FULL_RETENTION_DAYS || 365)),
  incrementalCron: () => process.env.BACKUP_INCREMENTAL_CRON || '15 2 * * 1-6',
  fullCron: () => process.env.BACKUP_FULL_CRON || '30 2 * * 0',
  timezone: () => process.env.BACKUP_TIMEZONE || process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata',
  hospitalName: () => process.env.HOSPITAL_NAME || 'Hospital',
  b2Prefix: () => String(process.env.B2_BACKUP_PREFIX || process.env.BACKUP_B2_PREFIX || 'backups/database').replace(/^\/+|\/+$/g, ''),
  googleFolderName: () => process.env.GDRIVE_BACKUP_FOLDER || process.env.HOSPITAL_NAME || 'Hospital'
};
