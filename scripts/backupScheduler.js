const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { performBackup, cleanOldBackups, BACKUP_DIR } = require('./backup');
const {
  backupEnabled,
  incrementalEnabled,
  fullEnabled,
  incrementalCron,
  fullCron,
  timezone
} = require('../services/backup/config');
const { startChangeTracker, getChangeTrackerStatus } = require('../services/backup/changeTracker.service');
const BackupRun = require('../models/BackupRun');

const LOG_DIR = process.env.HIMS_BACKUP_LOG_DIR || path.join(BACKUP_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backup_cron.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

let incrementalJob = null;
let fullJob = null;

function logMessage(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
}

async function runBackup(type, reason = 'scheduled') {
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI);
      connectedHere = true;
    }
    logMessage(`Starting ${type} backup (${reason})`);
    const result = await performBackup({ type, reason });
    cleanOldBackups();
    if (result.skipped) logMessage(`${type} backup skipped: no database changes since last checkpoint`);
    else if (result.success) logMessage(`${type} backup completed: ${result.backupId} (${result.status})`);
    else logMessage(`${type} backup failed: ${result.error || result.status}`);
    return result;
  } catch (error) {
    logMessage(`${type} backup failed: ${error.message}`);
    return { success: false, type, error: error.message };
  } finally {
    if (connectedHere) await mongoose.disconnect();
  }
}

async function startBackupScheduler() {
  if (!backupEnabled()) {
    logMessage('Backup scheduler disabled by BACKUP_ENABLED=false');
    return null;
  }

  if (incrementalEnabled()) await startChangeTracker();
  const tz = timezone();

  if (incrementalEnabled()) {
    if (!cron.validate(incrementalCron())) throw new Error(`Invalid BACKUP_INCREMENTAL_CRON: ${incrementalCron()}`);
    incrementalJob = cron.schedule(incrementalCron(), () => runBackup('incremental'), { timezone: tz });
    logMessage(`Incremental backup schedule: ${incrementalCron()} (${tz})`);
  }

  if (fullEnabled()) {
    if (!cron.validate(fullCron())) throw new Error(`Invalid BACKUP_FULL_CRON: ${fullCron()}`);
    fullJob = cron.schedule(fullCron(), () => runBackup('full'), { timezone: tz });
    logMessage(`Full backup schedule: ${fullCron()} (${tz})`);
  }

  return { incrementalJob, fullJob };
}

async function triggerManualBackup(type = 'incremental') {
  return runBackup(type, 'manual');
}

async function getBackupStatus() {
  const lastRun = await BackupRun.findOne().sort({ createdAt: -1 }).lean().catch(() => null);
  const lastFull = await BackupRun.findOne({ type: 'full', status: { $in: ['success', 'partial'] } }).sort({ completedAt: -1 }).lean().catch(() => null);
  const lastIncremental = await BackupRun.findOne({ type: 'incremental', status: { $in: ['success', 'partial', 'skipped'] } }).sort({ completedAt: -1 }).lean().catch(() => null);
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
    logFile: LOG_FILE
  };
}

module.exports = {
  startBackupScheduler,
  triggerManualBackup,
  getBackupStatus,
  runBackup
};
