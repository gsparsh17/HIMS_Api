const express = require('express');
const router = express.Router();
const { triggerManualBackup, getBackupStatus } = require('../scripts/backupScheduler');
const fs = require('fs');
const path = require('path');

// Get backup status
router.get('/status', async (req, res) => {
    try {
        const status = getBackupStatus();
        res.json({ success: true, ...status });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trigger manual backup
router.post('/trigger', async (req, res) => {
    try {
        const result = await triggerManualBackup();
        res.json({ 
            success: result, 
            message: result ? 'Backup triggered successfully' : 'Backup failed' 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download backup file
router.get('/download/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const backupDir = '/var/backups/mongodb/weekly';
        const filePath = path.join(backupDir, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Backup file not found' });
        }
        
        res.download(filePath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List available backups
router.get('/list', async (req, res) => {
    try {
        const backupDir = '/var/backups/mongodb/weekly';
        
        if (!fs.existsSync(backupDir)) {
            return res.json({ backups: [] });
        }
        
        const files = fs.readdirSync(backupDir);
        const backups = files
            .filter(f => f.endsWith('.tar.gz'))
            .map(f => {
                const stats = fs.statSync(path.join(backupDir, f));
                return {
                    name: f,
                    size: stats.size,
                    sizeFormatted: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                    date: stats.mtime,
                    dateFormatted: stats.mtime.toLocaleString()
                };
            })
            .sort((a, b) => b.date - a.date);
        
        res.json({ success: true, backups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;