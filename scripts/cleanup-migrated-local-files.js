'use strict';
require('dotenv').config();

const fs = require('fs');
const mongoose = require('mongoose');
const StoredFile = require('../models/StoredFile');
const fileStorage = require('../services/fileStorage.service');
const b2Storage = require('../services/b2Storage.service');

(async () => {
  try {
    b2Storage.assertConfigured();
    await mongoose.connect(process.env.MONGO_URI);

    const cursor = StoredFile.find({ storageDriver: 'b2', status: 'active' }).cursor();
    const counts = { deleted: 0, no_local_copy: 0, remote_missing: 0, checksum_mismatch: 0, failed: 0 };

    for await (const record of cursor) {
      try {
        const localPath = fileStorage.absolutePath(record.storageKey);
        if (!fs.existsSync(localPath)) {
          counts.no_local_copy += 1;
          continue;
        }

        const remote = await b2Storage.findFile(record.storageKey);
        if (!remote) {
          counts.remote_missing += 1;
          console.warn(`remote_missing: ${record.storageKey}`);
          continue;
        }

        const remoteSha256 = String(remote.fileInfo?.sha256 || '').toLowerCase();
        const expectedSha256 = String(record.sha256 || '').toLowerCase();
        if (!remoteSha256 || remoteSha256 !== expectedSha256) {
          counts.checksum_mismatch += 1;
          console.warn(`checksum_mismatch: ${record.storageKey}`);
          continue;
        }

        await fs.promises.unlink(localPath);
        counts.deleted += 1;
        console.log(`deleted_verified_local_copy: ${record.storageKey}`);
      } catch (error) {
        counts.failed += 1;
        console.error(`failed: ${record.storageKey}: ${error.message}`);
      }
    }

    console.log('Verified local cleanup summary:', counts);
    await mongoose.disconnect();
    process.exit(counts.failed ? 2 : 0);
  } catch (error) {
    console.error('Verified local cleanup failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
