
const path = require('path');

/*
 * ============================================================
 * BACKUP DIRECTORIES
 * ============================================================
 *
 * Priority:
 *
 * 1. HIMS_BACKUP_DIR
 * 2. MONGODB_BACKUP_DIR (legacy compatibility)
 * 3. ./backups inside the application directory
 *
 * Never default to a root-level path such as:
 *
 *     /backups
 *
 * because Render does not allow the application process to
 * create directories directly under the filesystem root.
 */

const configuredBackupDir =
  process.env.HIMS_BACKUP_DIR ||
  process.env.MONGODB_BACKUP_DIR ||
  path.join(process.cwd(), 'backups');

const BACKUP_DIR = path.resolve(
  configuredBackupDir
);

/*
 * Temporary backup files are kept inside the backup directory.
 *
 * Example on Render:
 *
 * HIMS_BACKUP_DIR=/tmp/backups
 *
 * becomes:
 *
 * /tmp/backups/temp
 */
const TEMP_DIR = path.join(
  BACKUP_DIR,
  'temp'
);


/*
 * ============================================================
 * BOOLEAN ENVIRONMENT VARIABLE
 * ============================================================
 */

function boolEnv(
  name,
  fallback
) {
  const raw =
    process.env[name];

  if (
    raw === undefined ||
    raw === ''
  ) {
    return fallback;
  }

  return String(raw)
    .toLowerCase()
    .trim() === 'true';
}


/*
 * ============================================================
 * LIST ENVIRONMENT VARIABLE
 * ============================================================
 */

function listEnv(
  name,
  fallback = []
) {
  const raw =
    String(
      process.env[name] || ''
    ).trim();

  if (!raw) {
    return fallback;
  }

  return [
    ...new Set(
      raw
        .split(',')
        .map((x) =>
          x.trim().toLowerCase()
        )
        .filter(Boolean)
    )
  ];
}


/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

module.exports = {

  /*
   * ----------------------------------------------------------
   * Directories
   * ----------------------------------------------------------
   */

  BACKUP_DIR,

  TEMP_DIR,


  /*
   * ----------------------------------------------------------
   * Backup enablement
   * ----------------------------------------------------------
   *
   * Your Render environment currently uses:
   *
   * BACKUP_ENABLED=false
   *
   * Therefore the scheduler will remain disabled.
   */

  backupEnabled: () =>
    boolEnv(
      'BACKUP_ENABLED',
      true
    ),

  incrementalEnabled: () =>
    boolEnv(
      'BACKUP_INCREMENTAL_ENABLED',
      true
    ),

  fullEnabled: () =>
    boolEnv(
      'BACKUP_FULL_ENABLED',
      true
    ),

  incrementalFallbackToFull: () =>
    boolEnv(
      'BACKUP_INCREMENTAL_FALLBACK_TO_FULL',
      false
    ),


  /*
   * ----------------------------------------------------------
   * Backup providers
   * ----------------------------------------------------------
   */

  providers: () =>
    listEnv(
      'BACKUP_STORAGE_PROVIDERS',
      ['local']
    ),

  requiredProviders: () =>
    listEnv(
      'BACKUP_REQUIRED_TARGETS',
      listEnv(
        'BACKUP_STORAGE_PROVIDERS',
        ['local']
      )
    ),


  /*
   * ----------------------------------------------------------
   * Retention
   * ----------------------------------------------------------
   */

  localRetentionDays: () =>
    Math.max(
      1,
      Number(
        process.env.BACKUP_LOCAL_RETENTION_DAYS ||
        process.env.BACKUP_RETENTION_DAYS ||
        30
      )
    ),

  incrementalRetentionDays: () =>
    Math.max(
      1,
      Number(
        process.env.BACKUP_INCREMENTAL_RETENTION_DAYS ||
        90
      )
    ),

  fullRetentionDays: () =>
    Math.max(
      1,
      Number(
        process.env.BACKUP_FULL_RETENTION_DAYS ||
        365
      )
    ),


  /*
   * ----------------------------------------------------------
   * Cron schedules
   * ----------------------------------------------------------
   */

  incrementalCron: () =>
    process.env.BACKUP_INCREMENTAL_CRON ||
    '15 2 * * 1-6',

  fullCron: () =>
    process.env.BACKUP_FULL_CRON ||
    '30 2 * * 0',


  /*
   * ----------------------------------------------------------
   * Timezone
   * ----------------------------------------------------------
   */

  timezone: () =>
    process.env.BACKUP_TIMEZONE ||
    process.env.HOSPITAL_TIME_ZONE ||
    'Asia/Kolkata',


  /*
   * ----------------------------------------------------------
   * Hospital
   * ----------------------------------------------------------
   */

  hospitalName: () =>
    process.env.HOSPITAL_NAME ||
    'Hospital',


  /*
   * ----------------------------------------------------------
   * Backblaze B2 backup prefix
   * ----------------------------------------------------------
   */

  b2Prefix: () =>
    String(
      process.env.B2_BACKUP_PREFIX ||
      process.env.BACKUP_B2_PREFIX ||
      'backups/database'
    )
      .replace(
        /^\/+|\/+$/g,
        ''
      ),


  /*
   * ----------------------------------------------------------
   * Google Drive
   * ----------------------------------------------------------
   */

  googleFolderName: () =>
    process.env.GDRIVE_BACKUP_FOLDER ||
    process.env.HOSPITAL_NAME ||
    'Hospital'
};