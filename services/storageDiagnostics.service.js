const fs = require('fs');
const path = require('path');
const os = require('os');
const fileStorage = require('./fileStorage.service');
const {
  BACKUP_DIR,
  TEMP_DIR,
  nodeRole,
  instanceId,
  backupNodeEnabled,
  schedulerEnabled
} = require('./backup/config');

const fsp = fs.promises;

async function directoryStatus(directory) {
  const resolved = path.resolve(directory);
  const result = {
    path: resolved,
    exists: false,
    readable: false,
    writable: false
  };
  try {
    await fsp.mkdir(resolved, { recursive: true });
    result.exists = true;
    try {
      await fsp.access(resolved, fs.constants.R_OK);
      result.readable = true;
    } catch (_) {}
    try {
      await fsp.access(resolved, fs.constants.W_OK);
      result.writable = true;
    } catch (_) {}
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function writeRoundTripProbe(directory, prefix) {
  const resolved = path.resolve(directory);
  await fsp.mkdir(resolved, { recursive: true });
  const probePath = path.join(resolved, `.${prefix}-${process.pid}-${Date.now()}.txt`);
  const value = `MediQliq ${prefix} probe ${new Date().toISOString()}`;
  try {
    await fsp.writeFile(probePath, value, { flag: 'wx' });
    const roundTrip = await fsp.readFile(probePath, 'utf8');
    if (roundTrip !== value) throw new Error('Probe read-back did not match the written content');
    return { success: true, directory: resolved };
  } finally {
    await fsp.unlink(probePath).catch(() => {});
  }
}

async function getStorageDiagnostics({ probeWrite = false } = {}) {
  const media = await fileStorage.getLocalStorageInfo({ probeWrite });
  const isBackupNode = backupNodeEnabled();
  const backup = isBackupNode
    ? await directoryStatus(BACKUP_DIR)
    : { path: path.resolve(BACKUP_DIR), exists: null, readable: null, writable: null, notRequiredOnThisNode: true };
  const backupTemp = isBackupNode
    ? await directoryStatus(TEMP_DIR)
    : { path: path.resolve(TEMP_DIR), exists: null, readable: null, writable: null, notRequiredOnThisNode: true };

  let backupProbe = null;
  if (probeWrite && isBackupNode) {
    try {
      backupProbe = await writeRoundTripProbe(path.join(BACKUP_DIR, '.healthchecks'), 'mediqliq-backup');
    } catch (error) {
      backupProbe = { success: false, directory: BACKUP_DIR, error: error.message };
    }
  }

  return {
    checkedAt: new Date(),
    machine: {
      nodeRole: nodeRole(),
      instanceId: instanceId(),
      hostname: os.hostname(),
      pid: process.pid,
      platform: process.platform,
      backupNode: backupNodeEnabled(),
      schedulerEnabled: schedulerEnabled()
    },
    media,
    backup,
    backupTemp,
    backupProbe
  };
}

module.exports = {
  directoryStatus,
  writeRoundTripProbe,
  getStorageDiagnostics
};
