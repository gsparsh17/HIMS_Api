const mongoose = require('mongoose');
require('dotenv').config();
const {
  performBackup,
  createFullBackup,
  createIncrementalBackup,
  cleanOldBackups,
  BACKUP_DIR
} = require('../services/backup/backupEngine.service');
const { localRetentionDays } = require('../services/backup/config');

const BACKUP_RETENTION_DAYS = localRetentionDays();

async function main() {
  const typeArg = process.argv.find((arg) => arg.startsWith('--type='));
  const type = typeArg ? typeArg.split('=')[1] : 'incremental';
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI);
      connectedHere = true;
    }
    const result = await performBackup({ type, reason: 'cli' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  } finally {
    if (connectedHere) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  performBackup,
  createFullBackup,
  createIncrementalBackup,
  cleanOldBackups,
  BACKUP_DIR,
  BACKUP_RETENTION_DAYS
};
