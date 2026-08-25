'use strict';
require('dotenv').config();
const b2Storage = require('../services/b2Storage.service');

(async () => {
  try {
    const status = await b2Storage.testConnection();
    console.log('✅ Backblaze B2 connection OK');
    console.log(`Bucket: ${status.bucketName}`);
    console.log(`Bucket ID: ${status.bucketId}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Backblaze B2 connection failed:', error.message);
    process.exit(1);
  }
})();
