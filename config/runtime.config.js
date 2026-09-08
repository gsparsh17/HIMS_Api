const fs = require('fs');
const path = require('path');
const { BACKUP_DIR, lanDeploymentEnabled, backupEnabled, backupNodeEnabled, schedulerEnabled, nodeRole } = require('../services/backup/config');

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function assertRuntimeConfig() {
  const errors = [];
  const production = process.env.NODE_ENV === 'production';
  const lanMode = lanDeploymentEnabled();

  // ============================================================
  // DATABASE
  // ============================================================

  if (!process.env.MONGO_URI) {
    errors.push('MONGO_URI is required');
  }

  // ============================================================
  // CORS
  // ============================================================

  if (
    production &&
    !String(
      process.env.CORS_ORIGINS || process.env.FRONTEND_URL || ''
    ).trim()
  ) {
    errors.push(
      'CORS_ORIGINS or FRONTEND_URL is required in production'
    );
  }


  // ============================================================
  // LAN DEPLOYMENT (OPT-IN ONLY)
  // ============================================================
  if (lanMode) {
    const role = nodeRole();
    if (!['SERVER', 'CLIENT'].includes(role)) {
      errors.push(`NODE_ROLE must be SERVER or CLIENT when LAN_DEPLOYMENT_ENABLED=true (received ${role})`);
    }
    if (schedulerEnabled() && !backupNodeEnabled()) {
      errors.push('BACKUP_SCHEDULER_ENABLED=true is not allowed on a non-backup LAN client node');
    }
  }

  // ============================================================
  // MEDIA STORAGE
  // ============================================================

  const mediaProvider = String(
    process.env.MEDIA_STORAGE_PROVIDER ||
      process.env.FILE_STORAGE_DRIVER ||
      'local'
  ).toLowerCase();

  if (!['local', 'b2', 'cloudinary'].includes(mediaProvider)) {
    errors.push(
      `MEDIA_STORAGE_PROVIDER must be local, b2 or cloudinary (received ${mediaProvider})`
    );
  }

  // Backblaze B2 configuration
  if (mediaProvider === 'b2') {
    for (const name of [
      'B2_KEY_ID',
      'B2_APPLICATION_KEY',
      'B2_BUCKET_NAME',
    ]) {
      if (!String(process.env[name] || '').trim()) {
        errors.push(
          `${name} is required when MEDIA_STORAGE_PROVIDER=b2`
        );
      }
    }
  }

  // Cloudinary configuration
  if (mediaProvider === 'cloudinary') {
    for (const name of [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ]) {
      if (!String(process.env[name] || '').trim()) {
        errors.push(
          `${name} is required when MEDIA_STORAGE_PROVIDER=cloudinary`
        );
      }
    }
  }

  // ============================================================
  // OPTIONAL SECURITY CHECKS
  // ============================================================

  // if (production && boolEnv('DISABLE_PERMISSION_CHECKS')) {
  //   errors.push(
  //     'DISABLE_PERMISSION_CHECKS must be false in production'
  //   );
  // }

  // if (production && boolEnv('ALLOW_PUBLIC_HOSPITAL_REGISTRATION')) {
  //   errors.push(
  //     'ALLOW_PUBLIC_HOSPITAL_REGISTRATION must be false in production'
  //   );
  // }

  // ============================================================
  // STORAGE DIRECTORIES
  // ============================================================

  /*
   * Permanent upload directory:
   *
   * - Required only when using local storage.
   * - NOT required for B2 or Cloudinary.
   *
   * This prevents Render from trying to create:
   *
   *     /srv/mediqliq/uploads
   *
   * when media storage is B2.
   */
  const sharedStorageRoot = lanMode ? String(process.env.HIMS_SHARED_STORAGE_ROOT || '').trim() : '';
  const uploadDir = path.resolve(
    process.env.UPLOAD_DIR ||
      sharedStorageRoot ||
      path.join(process.cwd(), 'uploads', 'storage')
  );

  /*
   * Temporary upload directory:
   *
   * This can be used by upload processing before the file
   * is sent to B2 or Cloudinary.
   *
   * On Render, /tmp is writable and appropriate for temporary
   * files.
   */
  const uploadTmpDir = path.resolve(
    process.env.UPLOAD_TMP_DIR ||
      (sharedStorageRoot ? path.join(sharedStorageRoot, 'temp') : path.join(process.cwd(), 'uploads', 'tmp'))
  );

  /*
   * Only validate the permanent upload directory when
   * using local storage.
   *
   * For B2/Cloudinary, permanent media is stored remotely,
   * so the local permanent directory is unnecessary.
   */
  const directoriesToCheck = [uploadTmpDir];

  if (mediaProvider === 'local') {
    directoriesToCheck.push(uploadDir);
  }

  if (lanMode && backupEnabled() && backupNodeEnabled()) {
    directoriesToCheck.push(BACKUP_DIR);
  }

  for (const directory of [...new Set(directoriesToCheck)]) {
    try {
      fs.mkdirSync(directory, { recursive: true });

      fs.accessSync(
        directory,
        fs.constants.R_OK | fs.constants.W_OK
      );
    } catch (error) {
      errors.push(
        `Storage directory is not writable: ${directory} (${error.message})`
      );
    }
  }

  // ============================================================
  // FINAL VALIDATION
  // ============================================================

  if (errors.length) {
    const error = new Error(
      `Invalid deployment configuration:\n- ${errors.join('\n- ')}`
    );

    error.code = 'INVALID_RUNTIME_CONFIGURATION';

    throw error;
  }

  // ============================================================
  // RETURN CONFIGURATION
  // ============================================================

  return {
    uploadDir,
    uploadTmpDir,
    ...(lanMode ? { backupDir: BACKUP_DIR, nodeRole: nodeRole(), backupNode: backupNodeEnabled() } : {})
  };
}

module.exports = { assertRuntimeConfig };
