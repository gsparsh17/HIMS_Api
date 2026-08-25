'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const unzipper = require('unzipper');
const router = express.Router();
const { triggerManualBackup, getBackupStatus } = require('../scripts/backupScheduler');
const {
  cleanOldBackups,
  BACKUP_DIR,
  BACKUP_RETENTION_DAYS
} = require('../scripts/backup');
const {
  FULL_SCHEMA,
  INCREMENTAL_SCHEMA,
  parseEjson
} = require('../services/backup/backupEngine.service');
const { providers, requiredProviders } = require('../services/backup/config');
const BackupRun = require('../models/BackupRun');
const { protect, isAdmin } = require('../middlewares/auth');

const backupDir = BACKUP_DIR;
const isSafeBackupName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(name || '') && path.basename(name) === name;

router.use(protect, isAdmin);

router.get('/status', async (_req, res) => {
  try {
    res.json({
      success: true,
      backupDir,
      retentionDays: BACKUP_RETENTION_DAYS,
      storageProviders: providers(),
      requiredTargets: requiredProviders(),
      ...(await getBackupStatus())
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/trigger', async (req, res) => {
  try {
    const type = String(req.body?.type || 'incremental').toLowerCase();
    if (!['full', 'incremental'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be full or incremental' });
    }
    const result = await triggerManualBackup(type);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/runs', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const runs = await BackupRun.find().sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ success: true, runs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/list', async (_req, res) => {
  try {
    if (!fs.existsSync(backupDir)) return res.json({ success: true, backups: [] });
    const backups = fs.readdirSync(backupDir)
      .filter(isSafeBackupName)
      .map((name) => {
        const stats = fs.statSync(path.join(backupDir, name));
        return {
          name,
          size: stats.size,
          sizeFormatted: `${(stats.size / (1024 * 1024)).toFixed(2)} MB`,
          date: stats.mtime,
          expiresAt: new Date(stats.mtimeMs + BACKUP_RETENTION_DAYS * 86400000)
        };
      })
      .sort((a, b) => b.date - a.date);
    return res.json({ success: true, backups, retentionDays: BACKUP_RETENTION_DAYS });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/retention/prune', async (_req, res) => {
  try {
    return res.json({ success: true, ...cleanOldBackups() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/download/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!isSafeBackupName(filename)) return res.status(400).json({ success: false, message: 'Invalid backup filename' });
    const filePath = path.resolve(backupDir, filename);
    if (!filePath.startsWith(`${path.resolve(backupDir)}${path.sep}`) || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Backup file not found' });
    }
    return res.download(filePath, filename);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function readBackupPayload(filePath) {
  const directory = await unzipper.Open.file(filePath);
  const fullEjson = directory.files.find((x) => x.path === 'restore_payload.ejson');
  if (fullEjson) return parseEjson((await fullEjson.buffer()).toString('utf8'));
  const incrementalEjson = directory.files.find((x) => x.path === 'incremental_payload.ejson');
  if (incrementalEjson) return parseEjson((await incrementalEjson.buffer()).toString('utf8'));

  // Backward compatibility with pre-modular complete backups.
  const legacy = directory.files.find((x) => x.path === 'restore_payload.json');
  if (legacy) return JSON.parse((await legacy.buffer()).toString('utf8'));
  throw new Error('Backup does not contain a supported restore payload');
}

function summarizePayload(payload) {
  if (payload.schemaVersion === FULL_SCHEMA || payload.schemaVersion === 'hims-complete-backup-1') {
    const collections = Array.isArray(payload.collections) ? payload.collections : [];
    return {
      type: 'full',
      schemaVersion: payload.schemaVersion,
      backupId: payload.backupId || null,
      collections: collections.length,
      documents: collections.reduce((sum, x) => sum + (Array.isArray(x.documents) ? x.documents.length : 0), 0)
    };
  }
  if (payload.schemaVersion === INCREMENTAL_SCHEMA) {
    return {
      type: 'incremental',
      schemaVersion: payload.schemaVersion,
      backupId: payload.backupId,
      baseFullBackupId: payload.baseFullBackupId,
      upserts: Array.isArray(payload.upserts) ? payload.upserts.length : 0,
      deletes: Array.isArray(payload.deletes) ? payload.deletes.length : 0
    };
  }
  throw new Error(`Unsupported restore payload schema: ${payload.schemaVersion || 'unknown'}`);
}

router.post('/restore/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!isSafeBackupName(filename)) return res.status(400).json({ success: false, message: 'Invalid backup filename' });
    const filePath = path.resolve(backupDir, filename);
    if (!filePath.startsWith(`${path.resolve(backupDir)}${path.sep}`) || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Backup file not found' });
    }

    const payload = await readBackupPayload(filePath);
    const summary = summarizePayload(payload);
    if (req.body?.dryRun !== false) return res.json({ success: true, dryRun: true, ...summary });

    if (String(process.env.ALLOW_BACKUP_RESTORE || 'false').toLowerCase() !== 'true') {
      return res.status(403).json({ success: false, message: 'Actual restore is disabled. Set ALLOW_BACKUP_RESTORE=true and provide confirmation.' });
    }
    if (req.body?.confirm !== `RESTORE:${filename}`) {
      return res.status(400).json({ success: false, message: `Confirmation must equal RESTORE:${filename}` });
    }

    if (summary.type === 'full') {
      const restored = [];
      for (const part of payload.collections || []) {
        const docs = Array.isArray(part.documents) ? part.documents : [];
        const ops = docs.filter((d) => d && d._id !== undefined).map((d) => ({
          replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true }
        }));
        if (ops.length) await mongoose.connection.db.collection(part.name).bulkWrite(ops, { ordered: false });
        restored.push({ collection: part.name, upserted: ops.length });
      }
      return res.json({ success: true, dryRun: false, type: 'full', restored });
    }

    const groupedUpserts = new Map();
    for (const item of payload.upserts || []) {
      if (!item?.collection || !item.document?._id) continue;
      if (!groupedUpserts.has(item.collection)) groupedUpserts.set(item.collection, []);
      groupedUpserts.get(item.collection).push(item.document);
    }
    for (const [collectionName, docs] of groupedUpserts.entries()) {
      const ops = docs.map((document) => ({ replaceOne: { filter: { _id: document._id }, replacement: document, upsert: true } }));
      if (ops.length) await mongoose.connection.db.collection(collectionName).bulkWrite(ops, { ordered: false });
    }
    for (const item of payload.deletes || []) {
      if (!item?.collection || item._id === undefined) continue;
      await mongoose.connection.db.collection(item.collection).deleteOne({ _id: item._id });
    }
    return res.json({ success: true, dryRun: false, type: 'incremental', ...summary });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = router;
