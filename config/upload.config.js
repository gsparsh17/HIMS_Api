const fs = require('fs');
const path = require('path');

const tempDir = path.resolve(process.env.UPLOAD_TMP_DIR || path.join(process.cwd(), 'uploads', 'tmp'));
fs.mkdirSync(tempDir, { recursive: true });

module.exports = { tempDir };
