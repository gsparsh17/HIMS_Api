const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const BackupChange = require('../../models/BackupChange');
const BackupRun = require('../../models/BackupRun');
const BackupState = require('../../models/BackupState');
const { getChangeTrackerStatus, recoverChangeTrackerAfterFull, INTERNAL_COLLECTIONS } = require('./changeTracker.service');
const { distribute } = require('./targetRegistry.service');
const {
  BACKUP_DIR,
  TEMP_DIR,
  localRetentionDays,
  incrementalRetentionDays,
  fullRetentionDays,
  incrementalFallbackToFull
} = require('./config');

const FULL_SCHEMA = 'hims-full-backup-2';
const INCREMENTAL_SCHEMA = 'hims-incremental-backup-1';
let backupInProgress = false;

function ensureDirs() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function backupId(type) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '_');
  return `${type}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function safeHospitalName() {
  return String(process.env.HOSPITAL_NAME || 'Hospital')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Hospital';
}

function writeEjson(filePath, value) {
  fs.writeFileSync(filePath, EJSON.stringify(value, { relaxed: false }), 'utf8');
}

function parseEjson(text) {
  return EJSON.parse(text, { relaxed: false });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function createZip(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(outputPath));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of files) archive.file(entry.path, { name: entry.name });
    archive.finalize();
  });
}

async function getState(key) {
  return BackupState.findOne({ key }).lean();
}

async function setState(key, value) {
  return BackupState.updateOne({ key }, { $set: { value } }, { upsert: true });
}

async function latestJournalEvent() {
  return BackupChange.findOne().sort({ _id: -1 }).select('_id').lean();
}

async function latestFullRun() {
  return BackupRun.findOne({ type: 'full', status: { $in: ['success', 'partial'] } })
    .sort({ completedAt: -1 })
    .lean();
}

function distributionStatus(distribution) {
  const anyFailed = Object.values(distribution.results || {}).some((x) => !x?.success);
  if (!distribution.success) return 'failed';
  return anyFailed ? 'partial' : 'success';
}

async function finalizeRun(run, { distribution, filePath, stats, checkpointEventId, baseFullBackupId }) {
  const completedAt = new Date();
  const status = distributionStatus(distribution);
  run.status = status;
  run.completedAt = completedAt;
  run.fileName = path.basename(filePath);
  run.localPath = distribution.results?.local?.location || null;
  run.targets = distribution.results;
  run.stats = stats || {};
  run.checkpointEventId = checkpointEventId || null;
  run.baseFullBackupId = baseFullBackupId || null;
  if (status === 'failed') run.error = `Required backup targets failed: ${distribution.missingRequired.join(', ')}`;
  await run.save();
  return { status, completedAt };
}

async function createFullBackup({ reason = 'scheduled' } = {}) {
  ensureDirs();
  const id = backupId('full');
  const run = await BackupRun.create({ backupId: id, type: 'full', status: 'running', stats: { reason } });
  const upperEvent = await latestJournalEvent();
  const tempDir = path.join(TEMP_DIR, id);
  fs.mkdirSync(tempDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'restore_payload.ejson');
  const manifestPath = path.join(tempDir, 'manifest.json');
  const zipPath = path.join(TEMP_DIR, `${safeHospitalName()}_${id}.zip`);

  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const payload = {
      schemaVersion: FULL_SCHEMA,
      backupId: id,
      type: 'full',
      createdAt: new Date(),
      database: mongoose.connection.name,
      collections: []
    };
    let totalDocuments = 0;
    for (const entry of collections) {
      const name = entry.name;
      if (!name || name.startsWith('system.') || INTERNAL_COLLECTIONS.has(name)) continue;
      const documents = await mongoose.connection.db.collection(name).find({}).toArray();
      payload.collections.push({ name, documents });
      totalDocuments += documents.length;
    }
    writeEjson(payloadPath, payload);
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: FULL_SCHEMA,
      backupId: id,
      type: 'full',
      createdAt: new Date().toISOString(),
      database: mongoose.connection.name,
      collections: payload.collections.map((x) => ({ name: x.name, documents: x.documents.length })),
      totalDocuments
    }, null, 2));
    await createZip([
      { path: manifestPath, name: 'manifest.json' },
      { path: payloadPath, name: 'restore_payload.ejson' }
    ], zipPath);
    const sha256 = await sha256File(zipPath);
    const fileSize = fs.statSync(zipPath).size;
    const context = {
      backupId: id,
      type: 'full',
      fileName: path.basename(zipPath),
      completedAt: new Date(),
      schemaVersion: FULL_SCHEMA
    };
    const distribution = await distribute(zipPath, context);
    const stats = {
      reason,
      collections: payload.collections.length,
      documents: totalDocuments,
      bytes: fileSize,
      sha256
    };
    const final = await finalizeRun(run, {
      distribution,
      filePath: zipPath,
      stats,
      checkpointEventId: upperEvent?._id || null
    });

    if (distribution.success) {
      await setState('last_full', { backupId: id, completedAt: final.completedAt, checkpointEventId: upperEvent?._id || null });
      await setState('incremental_checkpoint', { eventId: upperEvent?._id || null, backupId: id, updatedAt: final.completedAt });
      if (upperEvent?._id) await BackupChange.deleteMany({ _id: { $lte: upperEvent._id } });
      await recoverChangeTrackerAfterFull().catch(() => {});
    }

    return { success: distribution.success, backupId: id, type: 'full', status: final.status, fileName: path.basename(zipPath), stats, targets: distribution.results };
  } catch (error) {
    run.status = 'failed';
    run.completedAt = new Date();
    run.error = error.message;
    await run.save().catch(() => {});
    throw error;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.unlink(zipPath).catch(() => {});
  }
}

function documentGroupKey(change) {
  return `${change.collectionName}\u0000${EJSON.stringify(change.documentKey, { relaxed: false })}`;
}

async function createIncrementalBackup({ reason = 'scheduled' } = {}) {
  ensureDirs();
  const full = await latestFullRun();
  if (!full) return createFullBackup({ reason: `${reason}:initial-full-required` });

  const tracker = getChangeTrackerStatus();
  if (!tracker.running && tracker.enabled) {
    if (incrementalFallbackToFull()) return createFullBackup({ reason: `${reason}:incremental-tracker-unavailable` });
    const id = backupId('incremental');
    await BackupRun.create({
      backupId: id,
      type: 'incremental',
      status: 'failed',
      completedAt: new Date(),
      baseFullBackupId: full.backupId,
      error: `Incremental backup unavailable because MongoDB Change Streams are not running${tracker.lastError ? `: ${tracker.lastError}` : ''}`
    });
    return { success: false, backupId: id, type: 'incremental', status: 'failed', error: tracker.lastError || 'Change tracker is not running' };
  }

  const checkpoint = await getState('incremental_checkpoint');
  const lastEventId = checkpoint?.value?.eventId || null;
  const upperEvent = await latestJournalEvent();
  if (!upperEvent?._id || (lastEventId && String(upperEvent._id) === String(lastEventId))) {
    const id = backupId('incremental');
    await BackupRun.create({
      backupId: id,
      type: 'incremental',
      status: 'skipped',
      completedAt: new Date(),
      baseFullBackupId: full.backupId,
      stats: { reason, changedDocuments: 0, message: 'No database changes since the last successful checkpoint' }
    });
    return { success: true, skipped: true, backupId: id, type: 'incremental', status: 'skipped', changedDocuments: 0 };
  }

  const query = { _id: { $lte: upperEvent._id } };
  if (lastEventId) query._id.$gt = lastEventId;
  const changes = await BackupChange.find(query).sort({ _id: 1 }).lean();
  if (!changes.length) {
    await setState('incremental_checkpoint', { eventId: upperEvent._id, backupId: checkpoint?.value?.backupId || full.backupId, updatedAt: new Date() });
    return { success: true, skipped: true, type: 'incremental', status: 'skipped', changedDocuments: 0 };
  }

  const grouped = new Map();
  for (const change of changes) grouped.set(documentGroupKey(change), change);

  const byCollection = new Map();
  for (const change of grouped.values()) {
    if (!byCollection.has(change.collectionName)) byCollection.set(change.collectionName, []);
    byCollection.get(change.collectionName).push(change);
  }

  const upserts = [];
  const deletes = [];
  for (const [collectionName, collectionChanges] of byCollection.entries()) {
    const collection = mongoose.connection.db.collection(collectionName);
    for (const change of collectionChanges) {
      const idValue = change.documentKey?._id;
      if (change.operationType === 'delete') {
        deletes.push({ collection: collectionName, _id: idValue });
        continue;
      }
      const current = await collection.findOne({ _id: idValue });
      if (current) upserts.push({ collection: collectionName, document: current });
      else deletes.push({ collection: collectionName, _id: idValue });
    }
  }

  const id = backupId('incremental');
  const run = await BackupRun.create({ backupId: id, type: 'incremental', status: 'running', baseFullBackupId: full.backupId, stats: { reason } });
  const tempDir = path.join(TEMP_DIR, id);
  fs.mkdirSync(tempDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'incremental_payload.ejson');
  const manifestPath = path.join(tempDir, 'manifest.json');
  const zipPath = path.join(TEMP_DIR, `${safeHospitalName()}_${id}.zip`);

  try {
    const payload = {
      schemaVersion: INCREMENTAL_SCHEMA,
      backupId: id,
      type: 'incremental',
      baseFullBackupId: full.backupId,
      createdAt: new Date(),
      fromEventId: lastEventId,
      throughEventId: upperEvent._id,
      upserts,
      deletes
    };
    writeEjson(payloadPath, payload);
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: INCREMENTAL_SCHEMA,
      backupId: id,
      type: 'incremental',
      baseFullBackupId: full.backupId,
      createdAt: new Date().toISOString(),
      sourceEvents: changes.length,
      changedDocuments: grouped.size,
      upserts: upserts.length,
      deletes: deletes.length
    }, null, 2));
    await createZip([
      { path: manifestPath, name: 'manifest.json' },
      { path: payloadPath, name: 'incremental_payload.ejson' }
    ], zipPath);
    const sha256 = await sha256File(zipPath);
    const fileSize = fs.statSync(zipPath).size;
    const context = {
      backupId: id,
      type: 'incremental',
      baseFullBackupId: full.backupId,
      fileName: path.basename(zipPath),
      completedAt: new Date(),
      schemaVersion: INCREMENTAL_SCHEMA
    };
    const distribution = await distribute(zipPath, context);
    const stats = {
      reason,
      sourceEvents: changes.length,
      changedDocuments: grouped.size,
      upserts: upserts.length,
      deletes: deletes.length,
      bytes: fileSize,
      sha256
    };
    const final = await finalizeRun(run, {
      distribution,
      filePath: zipPath,
      stats,
      checkpointEventId: upperEvent._id,
      baseFullBackupId: full.backupId
    });
    if (distribution.success) {
      await setState('incremental_checkpoint', { eventId: upperEvent._id, backupId: id, updatedAt: final.completedAt });
      await BackupChange.deleteMany({ _id: { $lte: upperEvent._id } });
    }
    return { success: distribution.success, backupId: id, type: 'incremental', status: final.status, fileName: path.basename(zipPath), stats, targets: distribution.results };
  } catch (error) {
    run.status = 'failed';
    run.completedAt = new Date();
    run.error = error.message;
    await run.save().catch(() => {});
    throw error;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.unlink(zipPath).catch(() => {});
  }
}

function cleanOldBackups(retentionDays = null) {
  ensureDirs();
  let deleted = 0;
  let retained = 0;
  const now = Date.now();
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!/\.zip$/i.test(name)) continue;
    const filePath = path.join(BACKUP_DIR, name);
    const stat = fs.statSync(filePath);
    const days = retentionDays !== null
      ? Number(retentionDays)
      : (/_full-/i.test(name) ? fullRetentionDays() : (/_incremental-/i.test(name) ? incrementalRetentionDays() : localRetentionDays()));
    const cutoff = now - Math.max(1, days) * 86400000;
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      deleted += 1;
    } else retained += 1;
  }
  return {
    deleted,
    retained,
    retentionDays: retentionDays !== null ? Number(retentionDays) : {
      default: localRetentionDays(),
      incremental: incrementalRetentionDays(),
      full: fullRetentionDays()
    }
  };
}

async function performBackup(options = {}) {
  if (backupInProgress) {
    const error = new Error('Another backup is already in progress');
    error.code = 'BACKUP_ALREADY_RUNNING';
    throw error;
  }
  backupInProgress = true;
  try {
    const requested = String(options.type || 'incremental').toLowerCase();
    if (requested === 'full') return await createFullBackup(options);
    if (requested === 'incremental') return await createIncrementalBackup(options);
    throw new Error(`Unsupported backup type: ${requested}`);
  } finally {
    backupInProgress = false;
  }
}

module.exports = {
  FULL_SCHEMA,
  INCREMENTAL_SCHEMA,
  BACKUP_DIR,
  TEMP_DIR,
  parseEjson,
  createFullBackup,
  createIncrementalBackup,
  performBackup,
  cleanOldBackups
};
