const cron = require('node-cron');
const mongoose = require('mongoose');
const { performBackup } = require('./backup');
const fs = require('fs');
const path = require('path');

// Configuration
const LOG_DIR = 'D:\\backups\\logs';
const LOG_FILE = path.join(LOG_DIR, 'backup_cron.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Function to log messages
function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
    console.log(logEntry);
}

// Function to run backup
async function runBackup() {
    logMessage('==========================================');
    logMessage('Starting scheduled backup...');
    logMessage('==========================================');
    
    // Connect to MongoDB if not already connected
    let needDisconnect = false;
    if (mongoose.connection.readyState !== 1) {
        try {
            await mongoose.connect(process.env.MONGO_URI);
            logMessage('✅ Connected to MongoDB');
            needDisconnect = true;
        } catch (error) {
            logMessage(`❌ MongoDB connection failed: ${error.message}`);
            return false;
        }
    }
    
    const result = await performBackup();
    
    if (needDisconnect) {
        await mongoose.disconnect();
        logMessage('👋 Disconnected from MongoDB');
    }
    
    if (result.success) {
        logMessage('✅ Weekly backup completed successfully');
    } else {
        logMessage(`❌ Weekly backup failed: ${result.error}`);
    }
    
    return result.success;
}

// Schedule weekly backup: Every Sunday at 2:00 AM IST
const backupJob = cron.schedule('0 2 * * 0', async () => {
    logMessage('🕒 Cron job triggered weekly backup');
    await runBackup();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});

// Function to start the backup scheduler
function startBackupScheduler() {
    logMessage('🚀 Backup Scheduler started');
    logMessage(`📅 Schedule: Every Sunday at 2:00 AM IST`);
    logMessage(`📁 Log file: ${LOG_FILE}`);
    return backupJob;
}

// Manual trigger function (can be called from API)
async function triggerManualBackup() {
    logMessage('🔧 Manual backup triggered via API');
    return await runBackup();
}

// Get backup status
function getBackupStatus() {
    const status = {
        isRunning: backupJob ? true : false,
        schedule: '0 2 * * 0',
        scheduleReadable: 'Every Sunday at 2:00 AM IST',
        lastRun: null,
        nextRun: null
    };
    
    if (backupJob) {
        const nextDates = backupJob.getNextDates(1);
        if (nextDates && nextDates.length > 0) {
            status.nextRun = nextDates[0].toISOString();
        }
    }
    
    // Get last run from log file
    try {
        if (fs.existsSync(LOG_FILE)) {
            const logs = fs.readFileSync(LOG_FILE, 'utf8');
            const lines = logs.trim().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].includes('Weekly backup completed successfully') || 
                    lines[i].includes('Weekly backup failed')) {
                    const match = lines[i].match(/\[(.*?)\]/);
                    if (match) {
                        status.lastRun = match[1];
                        break;
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error reading log file:', error);
    }
    
    return status;
}

module.exports = {
    startBackupScheduler,
    triggerManualBackup,
    getBackupStatus
};