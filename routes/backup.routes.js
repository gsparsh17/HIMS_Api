const express = require('express');
const router = express.Router();
const { triggerManualBackup, getBackupStatus } = require('../scripts/backupScheduler');
const { protect, isAdmin } = require('../middlewares/auth');
const fs = require('fs');
const path = require('path');

const backupDir = process.env.MONGODB_BACKUP_DIR || '/var/backups/mongodb/weekly';
const isSafeBackupName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(name || '') && path.basename(name) === name;

// Backup artefacts can contain the full clinical/financial database. These endpoints are admin-only.
router.use(protect, isAdmin);

router.get('/status', async (_req, res) => {
  try {
    res.json({ success: true, ...getBackupStatus() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/trigger', async (_req, res) => {
  try {
    const result = await triggerManualBackup();
    res.json({ success: Boolean(result), message: result ? 'Backup triggered successfully' : 'Backup failed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
          dateFormatted: stats.mtime.toLocaleString()
        };
      })
      .sort((a, b) => b.date - a.date);
    res.json({ success: true, backups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

module.exports = router;
