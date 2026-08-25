'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const StoredFile = require('../models/StoredFile');
const fileStorage = require('../services/fileStorage.service');
const b2Storage = require('../services/b2Storage.service');

const deleteLocal = String(process.env.B2_MIGRATION_DELETE_LOCAL || 'false').toLowerCase() === 'true';

async function migrateRecord(record) {
  const filePath = fileStorage.absolutePath(record.storageKey);
  if (!fs.existsSync(filePath)) {
    return { status: 'missing_local', id: String(record._id), storageKey: record.storageKey };
  }

  const existing = await b2Storage.findFile(record.storageKey);
  let uploaded = existing;
  const existingSha = String(existing?.fileInfo?.sha256 || '').toLowerCase();
  if (!existing || !existingSha || existingSha !== String(record.sha256 || '').toLowerCase()) {
    uploaded = await b2Storage.uploadFile(filePath, record.storageKey, {
      contentType: record.mimeType,
      fileInfo: {
        sha256: record.sha256,
        category: record.category,
        visibility: record.visibility
      }
    });
  }

  record.storageDriver = 'b2';
  record.providerFileId = uploaded.fileId || record.providerFileId;
  await record.save();

  if (deleteLocal) {
    await fs.promises.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  return {
    status: existing && existingSha === String(record.sha256 || '').toLowerCase() ? 'linked_existing' : 'uploaded',
    id: String(record._id),
    storageKey: record.storageKey
  };
}

(async () => {
  try {
    b2Storage.assertConfigured();
    await mongoose.connect(process.env.MONGO_URI);
    const cursor = StoredFile.find({ storageDriver: 'local', status: 'active' }).cursor();
    const counts = { uploaded: 0, linked_existing: 0, missing_local: 0, failed: 0 };

    for await (const record of cursor) {
      try {
        const result = await migrateRecord(record);
        counts[result.status] = (counts[result.status] || 0) + 1;
        console.log(`${result.status}: ${result.storageKey}`);
      } catch (error) {
        counts.failed += 1;
        console.error(`failed: ${record.storageKey}: ${error.message}`);
      }
    }

    console.log('Migration summary:', counts);
    if (!deleteLocal) console.log('Local source files were retained. Set B2_MIGRATION_DELETE_LOCAL=true only after verification.');
    await mongoose.disconnect();
    process.exit(counts.failed ? 2 : 0);
  } catch (error) {
    console.error('B2 migration failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
