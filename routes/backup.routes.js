'use strict';

const express = require('express');
const router = express.Router();
const { triggerManualBackup, getBackupStatus } = require('../scripts/backupScheduler');
const { cleanOldBackups, BACKUP_DIR, BACKUP_RETENTION_DAYS } = require('../scripts/backup');
const { protect, isAdmin } = require('../middlewares/auth');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const unzipper = require('unzipper');

const backupDir = BACKUP_DIR;

const isSafeBackupName = (name) => {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/i.test(name || '') &&
         path.basename(name) === name;
};

router.use(protect, isAdmin);

// Get backup status
router.get('/status', async (_req, res) => {
  try {
    res.json({
      success: true,
      backupDir,
      retentionDays: BACKUP_RETENTION_DAYS,
      ...getBackupStatus()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Trigger manual backup
router.post('/trigger', async (_req, res) => {
  try {
    const result = await triggerManualBackup();

    res.status(result ? 200 : 500).json({
      success: Boolean(result),
      message: result ? 'Backup triggered successfully' : 'Backup failed'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// List available backups
router.get('/list', async (_req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      return res.json({
        success: true,
        backups: []
      });
    }

    const backups = fs
      .readdirSync(backupDir)
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

    return res.json({
      success: true,
      backups,
      retentionDays: BACKUP_RETENTION_DAYS
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Prune old backups
router.post('/retention/prune', async (_req, res) => {
  try {
    return res.json({
      success: true,
      ...cleanOldBackups(BACKUP_RETENTION_DAYS)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Download backup file
router.get('/download/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    if (!isSafeBackupName(filename)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup filename'
      });
    }

    const filePath = path.resolve(backupDir, filename);

    if (!filePath.startsWith(`${path.resolve(backupDir)}${path.sep}`) ||
        !fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Backup file not found'
      });
    }

    return res.download(filePath, filename);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Read restore payload from backup
async function readRestorePayload(filePath) {
  const directory = await unzipper.Open.file(filePath);
  const entry = directory.files.find((x) => x.path === 'restore_payload.json');

  if (!entry) {
    throw new Error('Backup does not contain restore_payload.json');
  }

  const buffer = await entry.buffer();
  const payload = JSON.parse(buffer.toString('utf8'));

  if (payload.schemaVersion !== 'hims-complete-backup-1' ||
      !Array.isArray(payload.collections)) {
    throw new Error('Unsupported restore payload');
  }

  return payload;
}

// Restore from backup
router.post('/restore/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    if (!isSafeBackupName(filename)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid backup filename'
      });
    }

    const filePath = path.resolve(backupDir, filename);

    if (!filePath.startsWith(`${path.resolve(backupDir)}${path.sep}`) ||
        !fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Backup file not found'
      });
    }

    const payload = await readRestorePayload(filePath);

    const summary = payload.collections.map((x) => ({
      collection: x.name,
      documents: Array.isArray(x.documents) ? x.documents.length : 0
    }));

    const totalDocuments = summary.reduce((sum, x) => sum + x.documents, 0);

    // Dry run
    if (req.body?.dryRun !== false) {
      return res.json({
        success: true,
        dryRun: true,
        schemaVersion: payload.schemaVersion,
        createdAt: payload.createdAt,
        totalCollections: summary.length,
        totalDocuments,
        summary
      });
    }

    // Check if restore is enabled
    if (String(process.env.ALLOW_BACKUP_RESTORE || 'false').toLowerCase() !== 'true') {
      return res.status(403).json({
        success: false,
        message: 'Actual restore is disabled. Set ALLOW_BACKUP_RESTORE=true and provide confirmation.'
      });
    }

    // Validate confirmation
    if (req.body?.confirm !== `RESTORE:${filename}`) {
      return res.status(400).json({
        success: false,
        message: `Confirmation must equal RESTORE:${filename}`
      });
    }

    // Execute restore
    const restored = [];

    for (const part of payload.collections) {
      const docs = Array.isArray(part.documents) ? part.documents : [];

      if (!docs.length) {
        restored.push({
          collection: part.name,
          upserted: 0
        });
        continue;
      }

      const ops = docs
        .filter((d) => d && d._id)
        .map((d) => ({
          replaceOne: {
            filter: { _id: d._id },
            replacement: d,
            upsert: true
          }
        }));

      if (ops.length) {
        await mongoose.connection.db
          .collection(part.name)
          .bulkWrite(ops, { ordered: false });
      }

      restored.push({
        collection: part.name,
        upserted: ops.length
      });
    }

    return res.json({
      success: true,
      dryRun: false,
      restored,
      totalDocuments
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;