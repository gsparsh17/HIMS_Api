const path = require('path');
const b2Storage = require('../../b2Storage.service');
const { b2Prefix } = require('../config');

function objectKey(context = {}) {
  const date = context.completedAt || new Date();
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return [b2Prefix(), context.type || 'backup', year, month, context.fileName || path.basename(context.filePath || '')]
    .filter(Boolean)
    .join('/');
}

async function upload(filePath, context = {}) {
  b2Storage.assertConfigured();
  const key = objectKey({ ...context, filePath });
  const uploaded = await b2Storage.uploadFile(filePath, key, {
    contentType: 'application/zip',
    fileInfo: {
      backup_id: context.backupId,
      backup_type: context.type,
      base_full: context.baseFullBackupId || '',
      schema: context.schemaVersion || ''
    }
  });
  return {
    provider: 'b2',
    success: true,
    location: key,
    fileId: uploaded.fileId,
    bytes: Number(uploaded.contentLength || 0)
  };
}

module.exports = { name: 'b2', upload };
