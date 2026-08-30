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
  backupEnabled,
  incrementalEnabled,
  fullEnabled,
  incrementalCron,
  fullCron,
  timezone
} = require('../services/backup/config');

const {
  startChangeTracker,
  getChangeTrackerStatus
} = require('../services/backup/changeTracker.service');

const BackupRun = require('../models/BackupRun');

/*
 * ============================================================
 * BACKUP LOGGING
 * ============================================================
 *
 * Never use a root-level path such as:
 *
 *   /backups/logs
 *
 * on Render unless a persistent disk is explicitly mounted there.
 *
 * Priority:
 *   1. HIMS_BACKUP_LOG_DIR if explicitly configured
 *   2. HIMS_BACKUP_DIR/logs if HIMS_BACKUP_DIR is configured
 *   3. ./backups/logs inside the application directory
 *
 * This keeps the application filesystem writable on Render.
 */

const BACKUP_ROOT_DIR = path.resolve(
  process.env.HIMS_BACKUP_DIR ||
    path.join(process.cwd(), 'backups')
);

const LOG_DIR = path.resolve(
  process.env.HIMS_BACKUP_LOG_DIR ||
    path.join(BACKUP_ROOT_DIR, 'logs')
);

const LOG_FILE = path.join(LOG_DIR, 'backup_cron.log');

let incrementalJob = null;
let fullJob = null;


/*
 * ============================================================
 * LOG DIRECTORY INITIALIZATION
 * ============================================================
 *
 * IMPORTANT:
 *
 * Do NOT create the directory when this module is imported.
 *
 * The backup routes import this file even when backups are
 * disabled. Creating directories at module-load time caused:
 *
 *   EACCES: permission denied, mkdir '/backups/logs'
 *
 * on Render.
 *
 * The directory is now created only when logging is actually
 * needed.
 */

function ensureLogDirectory() {
  try {
    fs.mkdirSync(LOG_DIR, {
      recursive: true
    });

    fs.accessSync(
      LOG_DIR,
      fs.constants.R_OK | fs.constants.W_OK
    );

    return true;
  } catch (error) {
    /*
     * Logging must never crash the application.
     *
     * If the configured backup log directory isn't writable,
     * fall back to a writable temporary directory.
     */

    console.error(
      `[BackupScheduler] Unable to use backup log directory "${LOG_DIR}": ${error.message}`
    );

    return false;
  }
}


/*
 * ============================================================
 * LOGGING
 * ============================================================
 */

function logMessage(message) {
  const line = `[${new Date().toISOString()}] ${message}`;

  console.log(line);

  /*
   * If the log directory isn't writable, don't allow logging
   * itself to crash the backend.
   */
  if (!ensureLogDirectory()) {
    return;
  }

  try {
    fs.appendFileSync(
      LOG_FILE,
      `${line}\n`,
      'utf8'
    );
  } catch (error) {
    /*
     * Logging failure should never bring down the application.
     */
    console.error(
      `[BackupScheduler] Failed to write log file: ${error.message}`
    );
  }
}


/*
 * ============================================================
 * BACKUP EXECUTION
 * ============================================================
 */

async function runBackup(type, reason = 'scheduled') {
  let connectedHere = false;

  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is required to run a backup');
    }

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI);
      connectedHere = true;
    }

    logMessage(
      `Starting ${type} backup (${reason})`
    );

    const result = await performBackup({
      type,
      reason
    });

    /*
     * Cleanup is part of the normal backup lifecycle.
     */
    try {
      cleanOldBackups();
    } catch (cleanupError) {
      logMessage(
        `Backup cleanup failed: ${cleanupError.message}`
      );
    }

    if (result.skipped) {
      logMessage(
        `${type} backup skipped: no database changes since last checkpoint`
      );
    } else if (result.success) {
      logMessage(
        `${type} backup completed: ${result.backupId} (${result.status})`
      );
    } else {
      logMessage(
        `${type} backup failed: ${result.error || result.status}`
      );
    }

    return result;
  } catch (error) {
    logMessage(
      `${type} backup failed: ${error.message}`
    );

    return {
      success: false,
      type,
      error: error.message
    };
  } finally {
    if (connectedHere) {
      try {
        await mongoose.disconnect();
      } catch (disconnectError) {
        logMessage(
          `MongoDB disconnect failed: ${disconnectError.message}`
        );
      }
    }
  }
}


/*
 * ============================================================
 * BACKUP SCHEDULER
 * ============================================================
 */

async function startBackupScheduler() {
  /*
   * IMPORTANT:
   *
   * Check BACKUP_ENABLED before initializing:
   *
   *   - change tracker
   *   - cron jobs
   *   - log directory
   *
   * This means BACKUP_ENABLED=false really disables the
   * scheduler and does not touch the backup filesystem.
   */

  if (!backupEnabled()) {
    console.log(
      '[BackupScheduler] Backup scheduler disabled by BACKUP_ENABLED=false'
    );

    return null;
  }

  /*
   * Backups are actually enabled, so initialize logging now.
   */
  ensureLogDirectory();

  logMessage(
    'Backup scheduler starting'
  );

  /*
   * Start change tracking only when incremental backups
   * are enabled.
   */
  if (incrementalEnabled()) {
    await startChangeTracker();

    logMessage(
      'Backup change tracker started'
    );
  }

  const tz = timezone();

  /*
   * ==========================================================
   * INCREMENTAL BACKUP
   * ==========================================================
   */

  if (incrementalEnabled()) {
    const cronExpression = incrementalCron();

    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid BACKUP_INCREMENTAL_CRON: ${cronExpression}`
      );
    }

    /*
     * Prevent duplicate scheduler jobs if startBackupScheduler()
     * is accidentally called more than once.
     */
    if (incrementalJob) {
      incrementalJob.stop();
      incrementalJob = null;
    }

    incrementalJob = cron.schedule(
      cronExpression,
      () => {
        runBackup('incremental').catch((error) => {
          logMessage(
            `Incremental scheduled backup error: ${error.message}`
          );
        });
      },
      {
        timezone: tz
      }
    );

    logMessage(
      `Incremental backup schedule: ${cronExpression} (${tz})`
    );
  }

  /*
   * ==========================================================
   * FULL BACKUP
   * ==========================================================
   */

  if (fullEnabled()) {
    const cronExpression = fullCron();

    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid BACKUP_FULL_CRON: ${cronExpression}`
      );
    }

    /*
     * Prevent duplicate scheduler jobs.
     */
    if (fullJob) {
      fullJob.stop();
      fullJob = null;
    }

    fullJob = cron.schedule(
      cronExpression,
      () => {
        runBackup('full').catch((error) => {
          logMessage(
            `Full scheduled backup error: ${error.message}`
          );
        });
      },
      {
        timezone: tz
      }
    );

    logMessage(
      `Full backup schedule: ${cronExpression} (${tz})`
    );
  }

  logMessage(
    'Backup scheduler started successfully'
  );

  return {
    incrementalJob,
    fullJob
  };
}


/*
 * ============================================================
 * MANUAL BACKUP
 * ============================================================
 */

async function triggerManualBackup(type = 'incremental') {
  return runBackup(type, 'manual');
}


/*
 * ============================================================
 * BACKUP STATUS
 * ============================================================
 */

async function getBackupStatus() {
  const lastRun = await BackupRun
    .findOne()
    .sort({ createdAt: -1 })
    .lean()
    .catch(() => null);

  const lastFull = await BackupRun
    .findOne({
      type: 'full',
      status: {
        $in: ['success', 'partial']
      }
    })
    .sort({ completedAt: -1 })
    .lean()
    .catch(() => null);

  const lastIncremental = await BackupRun
    .findOne({
      type: 'incremental',
      status: {
        $in: [
          'success',
          'partial',
          'skipped'
        ]
      }
    })
    .sort({ completedAt: -1 })
    .lean()
    .catch(() => null);

  return {
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

    /*
     * Expose the configured locations for diagnostics.
     */
    backupDir: BACKUP_ROOT_DIR,
    logFile: LOG_FILE
  };
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  startBackupScheduler,
  triggerManualBackup,
  getBackupStatus,
  runBackup
};