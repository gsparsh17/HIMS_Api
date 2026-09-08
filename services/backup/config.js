const os = require('os');
const path = require('path');

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase().trim() === 'true';
}

function listEnv(name, fallback = []) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  return [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/*
 * LAN_DEPLOYMENT_ENABLED is intentionally opt-in. When it is false or absent,
 * the backup/storage behavior remains the same as the existing cloud deployment.
 */
function lanDeploymentEnabled() {
  return boolEnv('LAN_DEPLOYMENT_ENABLED', false);
}

function nodeRole() {
  if (!lanDeploymentEnabled()) return 'CLOUD';
  return String(process.env.NODE_ROLE || 'CLIENT').trim().toUpperCase();
}

function instanceId() {
  return String(
    process.env.INSTANCE_ID ||
    process.env.BACKUP_INSTANCE_ID ||
    os.hostname() ||
    'MEDIQLIQ-INSTANCE'
  ).trim().slice(0, 120);
}

function backupNodeEnabled() {
  if (!lanDeploymentEnabled()) return true; // legacy/cloud: this restriction did not exist
  return boolEnv('BACKUP_NODE_ENABLED', nodeRole() === 'SERVER');
}

function schedulerEnabled() {
  if (!lanDeploymentEnabled()) return true; // legacy/cloud scheduler remains controlled only by BACKUP_ENABLED
  return boolEnv('BACKUP_SCHEDULER_ENABLED', backupNodeEnabled());
}

const sharedStorageRoot = lanDeploymentEnabled()
  ? String(process.env.HIMS_SHARED_STORAGE_ROOT || '').trim()
  : '';

const configuredBackupDir =
  process.env.HIMS_BACKUP_DIR ||
  process.env.MONGODB_BACKUP_DIR ||
  (sharedStorageRoot ? path.join(sharedStorageRoot, 'backups') : path.join(process.cwd(), 'backups'));

const BACKUP_DIR = path.resolve(configuredBackupDir);
const TEMP_DIR = path.join(BACKUP_DIR, 'temp');

module.exports = {
  BACKUP_DIR,
  TEMP_DIR,

  lanDeploymentEnabled,
  backupEnabled: () => boolEnv('BACKUP_ENABLED', true),
  backupNodeEnabled,
  schedulerEnabled,
  nodeRole,
  instanceId,

  incrementalEnabled: () => boolEnv('BACKUP_INCREMENTAL_ENABLED', true),
  fullEnabled: () => boolEnv('BACKUP_FULL_ENABLED', true),
  incrementalFallbackToFull: () => boolEnv('BACKUP_INCREMENTAL_FALLBACK_TO_FULL', false),

  providers: () => listEnv('BACKUP_STORAGE_PROVIDERS', ['local']),
  requiredProviders: () => listEnv('BACKUP_REQUIRED_TARGETS', listEnv('BACKUP_STORAGE_PROVIDERS', ['local'])),

  localRetentionDays: () => Math.max(1, Number(process.env.BACKUP_LOCAL_RETENTION_DAYS || process.env.BACKUP_RETENTION_DAYS || 30)),
  incrementalRetentionDays: () => Math.max(1, Number(process.env.BACKUP_INCREMENTAL_RETENTION_DAYS || 90)),
  fullRetentionDays: () => Math.max(1, Number(
    process.env.BACKUP_FULL_RETENTION_DAYS ||
    (lanDeploymentEnabled() ? process.env.BACKUP_RETENTION_DAYS : '') ||
    365
  )),

  incrementalCron: () => process.env.BACKUP_INCREMENTAL_CRON || '15 2 * * 1-6',
  fullCron: () => process.env.BACKUP_FULL_CRON || '30 2 * * 0',
  timezone: () => process.env.BACKUP_TIMEZONE || process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata',

  // LAN-only startup/cross-machine safeguards. They are ignored when LAN mode is off.
  startupCatchupEnabled: () => lanDeploymentEnabled() && boolEnv('BACKUP_STARTUP_CATCHUP_ENABLED', false),
  startupCatchupAfter: () => String(process.env.BACKUP_STARTUP_CATCHUP_AFTER || '03:00').trim(),
  startupCatchupType: () => String(process.env.BACKUP_STARTUP_CATCHUP_TYPE || 'full').trim().toLowerCase(),
  startupCatchupDelayMs: () => Math.max(0, Number(process.env.BACKUP_STARTUP_CATCHUP_DELAY_MS || 5000)),

  coordinatorLockEnabled: () => lanDeploymentEnabled() && boolEnv('BACKUP_COORDINATOR_LOCK_ENABLED', true),
  lockLeaseMs: () => Math.max(300000, Number(process.env.BACKUP_LOCK_LEASE_MS || 1800000)),
  lockHeartbeatMs: () => Math.max(15000, Number(process.env.BACKUP_LOCK_HEARTBEAT_MS || 60000)),

  hospitalName: () => process.env.HOSPITAL_NAME || 'Hospital',

  b2Prefix: () => String(process.env.B2_BACKUP_PREFIX || process.env.BACKUP_B2_PREFIX || 'backups/database')
    .replace(/^\/+|\/+$/g, ''),

  googleFolderName: () => process.env.GDRIVE_BACKUP_FOLDER || process.env.HOSPITAL_NAME || 'Hospital'
};
