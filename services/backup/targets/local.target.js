const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BACKUP_DIR, lanDeploymentEnabled } = require('../config');

async function syncFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function upload(filePath, context = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const destination = path.join(BACKUP_DIR, path.basename(filePath));
  if (path.resolve(filePath) !== path.resolve(destination)) {
    if (lanDeploymentEnabled()) {
      const partial = `${destination}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        await fs.promises.copyFile(filePath, partial, fs.constants.COPYFILE_EXCL);
        await syncFile(partial);
        await fs.promises.rename(partial, destination);
      } catch (error) {
        await fs.promises.unlink(partial).catch(() => {});
        throw error;
      }
    } else {
      await fs.promises.copyFile(filePath, destination);
    }
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
