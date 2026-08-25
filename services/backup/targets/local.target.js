const fs = require('fs');
const path = require('path');
const { BACKUP_DIR } = require('../config');

async function upload(filePath, context = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const destination = path.join(BACKUP_DIR, path.basename(filePath));
  if (path.resolve(filePath) !== path.resolve(destination)) {
    await fs.promises.copyFile(filePath, destination);
  }
  const stat = await fs.promises.stat(destination);
  return {
    provider: 'local',
    success: true,
    location: destination,
    bytes: stat.size,
    fileName: context.fileName || path.basename(destination)
  };
}

module.exports = { name: 'local', upload };
