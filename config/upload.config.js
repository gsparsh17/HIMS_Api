const fs = require('fs');
const path = require('path');

const lanDeploymentEnabled = String(process.env.LAN_DEPLOYMENT_ENABLED || '').trim().toLowerCase() === 'true';
const sharedStorageRoot = lanDeploymentEnabled ? String(process.env.HIMS_SHARED_STORAGE_ROOT || '').trim() : '';
const tempDir = path.resolve(
  process.env.UPLOAD_TMP_DIR ||
  (sharedStorageRoot ? path.join(sharedStorageRoot, 'temp') : path.join(process.cwd(), 'uploads', 'tmp'))
);
fs.mkdirSync(tempDir, { recursive: true });

module.exports = { tempDir };
