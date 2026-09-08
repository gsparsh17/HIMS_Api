const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  performBackup,
  cleanOldBackups,
  BACKUP_DIR
} = require('./backup');

const {
  lanDeploymentEnabled,
  backupEnabled,
  backupNodeEnabled,
  schedulerEnabled,
  nodeRole,
  instanceId,
  incrementalEnabled,
  fullEnabled,
  incrementalCron,
  fullCron,
  timezone,
  startupCatchupEnabled,
  startupCatchupAfter,
  startupCatchupType,
  startupCatchupDelayMs
} = require('../services/backup/config');

const {
  startChangeTracker,
  getChangeTrackerStatus
} = require('../services/backup/changeTracker.service');

const {
  scheduledRunKey,
  successfulScheduleExists,
  timeZoneParts,
  getCoordinatorStatus
} = require('../services/backup/backupCoordinator.service');

const BackupRun = require('../models/BackupRun');

const BACKUP_ROOT_DIR = path.resolve(
  lanDeploymentEnabled()
    ? BACKUP_DIR
    : (process.env.HIMS_BACKUP_DIR || path.join(process.cwd(), 'backups'))
);
const LOG_DIR = path.resolve(process.env.HIMS_BACKUP_LOG_DIR || path.join(BACKUP_ROOT_DIR, 'logs'));
const LOG_FILE = path.join(LOG_DIR, 'backup_cron.log');

let incrementalJob = null;
let fullJob = null;
let startupCatchupTimer = null;

function ensureLogDirectory() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.accessSync(LOG_DIR, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (error) {
    console.error(`[BackupScheduler] Unable to use backup log directory "${LOG_DIR}": ${error.message}`);
    return false;
  }
}

function logMessage(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!ensureLogDirectory()) return;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch (error) {
    console.error(`[BackupScheduler] Failed to write log file: ${error.message}`);
  }
}

async function runBackup(type, reason = 'scheduled', options = {}) {
  let connectedHere = false;
  const lanMode = lanDeploymentEnabled();
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required to run a backup');

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI);
      connectedHere = true;
    }

    const scheduleKey = lanMode ? (options.scheduleKey || null) : null;
    if (scheduleKey && await successfulScheduleExists(scheduleKey)) {
      logMessage(`${type} backup skipped: schedule key ${scheduleKey} has already completed`);
      return {
        success: true,
        skipped: true,
        duplicateSchedule: true,
        type,
        status: 'skipped',
        scheduleKey
      };
    }

    logMessage(lanMode
      ? `Starting ${type} backup (${reason}) on ${instanceId()}`
      : `Starting ${type} backup (${reason})`);

    const result = await performBackup(lanMode ? {
      type,
      reason,
      triggerSource: options.triggerSource || 'internal',
      scheduleKey
    } : {
      type,
      reason
    });

    try {
      cleanOldBackups();
    } catch (cleanupError) {
      logMessage(`Backup cleanup failed: ${cleanupError.message}`);
    }

    if (result.skipped) {
      logMessage(`${type} backup skipped: ${result.duplicateSchedule ? 'already completed for this schedule' : 'no database changes since last checkpoint'}`);
    } else if (result.success) {
      logMessage(`${type} backup completed: ${result.backupId} (${result.status})`);
    } else {
      logMessage(`${type} backup failed: ${result.error || result.status}`);
    }

    return result;
  } catch (error) {
    logMessage(`${type} backup failed: ${error.message}`);
    return {
      success: false,
      type,
      error: error.message,
      ...(lanMode ? { code: error.code || null, currentOwner: error.currentOwner || null } : {})
    };
  } finally {
    if (connectedHere) {
      try {
        await mongoose.disconnect();
      } catch (disconnectError) {
        logMessage(`MongoDB disconnect failed: ${disconnectError.message}`);
      }
    }
  }
}

async function runScheduledBackup(type, triggerSource = 'scheduled') {
  if (!lanDeploymentEnabled()) return runBackup(type, 'scheduled');
  const scheduleKey = scheduledRunKey(type);
  return runBackup(type, triggerSource, { triggerSource, scheduleKey });
}

function parseLocalTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid BACKUP_STARTUP_CATCHUP_AFTER: ${value}. Use HH:mm.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid BACKUP_STARTUP_CATCHUP_AFTER: ${value}. Use HH:mm.`);
  return hour * 60 + minute;
}

function typeEnabled(type) {
  if (type === 'full') return fullEnabled();
  if (type === 'incremental') return incrementalEnabled();
  return false;
}

function scheduleStartupCatchup() {
  if (!startupCatchupEnabled()) return;
  const type = startupCatchupType();
  if (!['full', 'incremental'].includes(type) || !typeEnabled(type)) {
    logMessage(`Startup catch-up disabled for unavailable backup type: ${type}`);
    return;
  }

  const targetMinutes = parseLocalTime(startupCatchupAfter());
  const parts = timeZoneParts(new Date(), timezone());
  const currentMinutes = parts.hour * 60 + parts.minute;
  const waitUntilThreshold = Math.max(0, targetMinutes - currentMinutes) * 60000;
  const delay = waitUntilThreshold + startupCatchupDelayMs();

  if (startupCatchupTimer) clearTimeout(startupCatchupTimer);
  startupCatchupTimer = setTimeout(() => {
    runScheduledBackup(type, 'startup-catchup').catch((error) => {
      logMessage(`Startup catch-up backup error: ${error.message}`);
    });
  }, delay);
  startupCatchupTimer.unref?.();

  logMessage(`Startup catch-up check scheduled for ${startupCatchupAfter()} ${timezone()} (${type})`);
}

async function startBackupScheduler() {
  if (!backupEnabled()) {
    console.log('[BackupScheduler] Backup scheduler disabled by BACKUP_ENABLED=false');
    return null;
  }

  if (lanDeploymentEnabled() && !backupNodeEnabled()) {
    console.log(`[BackupScheduler] This instance is not the backup node (NODE_ROLE=${nodeRole()}, INSTANCE_ID=${instanceId()}); no backup jobs will start`);
    return null;
  }

  if (lanDeploymentEnabled() && !schedulerEnabled()) {
    console.log('[BackupScheduler] Backup node is enabled but scheduled jobs are disabled by BACKUP_SCHEDULER_ENABLED=false');
    return null;
  }

  ensureLogDirectory();
  logMessage(lanDeploymentEnabled()
    ? `Backup scheduler starting on designated node ${instanceId()} (${nodeRole()})`
    : 'Backup scheduler starting');

  if (incrementalEnabled()) {
    await startChangeTracker();
    logMessage('Backup change tracker started');
  }

  const tz = timezone();

  if (incrementalEnabled()) {
    const expression = incrementalCron();
    if (!cron.validate(expression)) throw new Error(`Invalid BACKUP_INCREMENTAL_CRON: ${expression}`);
    if (incrementalJob) incrementalJob.stop();
    incrementalJob = cron.schedule(expression, () => {
      runScheduledBackup('incremental', 'scheduled').catch((error) => logMessage(`Incremental scheduled backup error: ${error.message}`));
    }, { timezone: tz });
    logMessage(`Incremental backup schedule: ${expression} (${tz})`);
  }

  if (fullEnabled()) {
    const expression = fullCron();
    if (!cron.validate(expression)) throw new Error(`Invalid BACKUP_FULL_CRON: ${expression}`);
    if (fullJob) fullJob.stop();
    fullJob = cron.schedule(expression, () => {
      runScheduledBackup('full', 'scheduled').catch((error) => logMessage(`Full scheduled backup error: ${error.message}`));
    }, { timezone: tz });
    logMessage(`Full backup schedule: ${expression} (${tz})`);
  }

  scheduleStartupCatchup();
  logMessage('Backup scheduler started successfully');
  return lanDeploymentEnabled()
    ? { incrementalJob, fullJob, startupCatchupTimer }
    : { incrementalJob, fullJob };
}


function stopBackupScheduler() {
  if (incrementalJob) {
    incrementalJob.stop();
    incrementalJob = null;
  }
  if (fullJob) {
    fullJob.stop();
    fullJob = null;
  }
  if (startupCatchupTimer) {
    clearTimeout(startupCatchupTimer);
    startupCatchupTimer = null;
  }
}

async function triggerManualBackup(type) {
  const resolvedType = type || (lanDeploymentEnabled() ? 'full' : 'incremental');
  return lanDeploymentEnabled()
    ? runBackup(resolvedType, 'manual', { triggerSource: 'manual' })
    : runBackup(resolvedType, 'manual');
}

async function getBackupStatus() {
  const lastRun = await BackupRun.findOne().sort({ createdAt: -1 }).lean().catch(() => null);
  const lastFull = await BackupRun.findOne({ type: 'full', status: { $in: ['success', 'partial'] } }).sort({ completedAt: -1 }).lean().catch(() => null);
  const lastIncremental = await BackupRun.findOne({ type: 'incremental', status: { $in: ['success', 'partial', 'skipped'] } }).sort({ completedAt: -1 }).lean().catch(() => null);

  const legacyStatus = {
    enabled: backupEnabled(),
    timezone: timezone(),
    incremental: {
      enabled: incrementalEnabled(),
      cron: incrementalCron(),
      tracker: getChangeTrackerStatus(),
      lastRun: lastIncremental
    },
    full: {
      enabled: fullEnabled(),
      cron: fullCron(),
      lastRun: lastFull
    },
    lastRun,
    backupDir: BACKUP_ROOT_DIR,
    logFile: LOG_FILE
  };

  if (!lanDeploymentEnabled()) return legacyStatus;

  return {
    ...legacyStatus,
    lanDeploymentEnabled: true,
    nodeRole: nodeRole(),
    instanceId: instanceId(),
    backupNode: backupNodeEnabled(),
    schedulerEnabled: schedulerEnabled(),
    schedulerRunning: Boolean(incrementalJob || fullJob),
    startupCatchup: {
      enabled: startupCatchupEnabled(),
      after: startupCatchupAfter(),
      type: startupCatchupType()
    },
    coordinator: await getCoordinatorStatus()
  };
}

module.exports = {
  startBackupScheduler,
  triggerManualBackup,
  getBackupStatus,
  runBackup,
  runScheduledBackup,
  stopBackupScheduler
};
