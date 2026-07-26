const fs = require('fs');
const path = require('path');

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function assertRuntimeConfig() {
  const errors = [];
  const production = process.env.NODE_ENV === 'production';

  if (!process.env.MONGO_URI) errors.push('MONGO_URI is required');
  // if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  //   errors.push('JWT_SECRET must be set to a random value of at least 32 characters');
  // }
  if (production && !String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').trim()) {
    errors.push('CORS_ORIGINS or FRONTEND_URL is required in production');
  }
  // if (production && boolEnv('DISABLE_PERMISSION_CHECKS')) {
  //   errors.push('DISABLE_PERMISSION_CHECKS must be false in production');
  // }
  // if (production && boolEnv('ALLOW_PUBLIC_HOSPITAL_REGISTRATION')) {
  //   errors.push('ALLOW_PUBLIC_HOSPITAL_REGISTRATION must be false in production');
  // }

  const uploadDir = path.resolve(
    process.env.UPLOAD_DIR || (production ? '/srv/mediqliq/uploads' : path.join(process.cwd(), 'uploads', 'storage'))
  );
  const uploadTmpDir = path.resolve(process.env.UPLOAD_TMP_DIR || path.join(process.cwd(), 'uploads', 'tmp'));
  for (const directory of [uploadDir, uploadTmpDir]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      errors.push(`Storage directory is not writable: ${directory} (${error.message})`);
    }
  }

  if (errors.length) {
    const error = new Error(`Invalid deployment configuration:\n- ${errors.join('\n- ')}`);
    error.code = 'INVALID_RUNTIME_CONFIGURATION';
    throw error;
  }

  return { uploadDir, uploadTmpDir };
}

module.exports = { assertRuntimeConfig };
