#!/usr/bin/env node
'use strict';

/**
 * Creates/updates a delegated hospital admin with a tightly restricted sidebar,
 * while preserving existing users' current feature entitlements.
 *
 * Default account:
 *   email:    testing@gmail.com
 *   password: testing123
 *
 * Default hospital:
 *   ObjectId: 69a697c0df37f940dd7906ce (Test Hospital / AZ4967)
 *
 * Usage:
 *   node scripts/seed-restricted-testing-admin.js
 *   node scripts/seed-restricted-testing-admin.js --dry-run
 *   node scripts/seed-restricted-testing-admin.js --hospital-id=<ObjectId>
 *   node scripts/seed-restricted-testing-admin.js --email=... --password=...
 *   node scripts/seed-restricted-testing-admin.js --no-preserve-existing
 *
 * MONGO_URI is required. DB_NAME is optional when the URI already includes a DB.
 *
 * Note: the requested password "testing123" does not satisfy the application's
 * default NABH password policy (uppercase/special-character requirements). This
 * one-time seed intentionally hashes it directly so the requested test login can
 * be created without weakening the hospital-wide password policy.
 */

require('dotenv').config();

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const {
  ACCESS_ORDER,
  MAIN_FEATURES,
  dashboardAccessFromFeatures,
  normalizeFeaturePermissions,
  normalizeAccess,
  toMainFeatureKey,
} = require('../utils/mainFeatureAccess');

const DEFAULT_HOSPITAL_ID = '69a697c0df37f940dd7906ce';
const DEFAULT_HOSPITAL_CODE = 'AZ4967';
const DEFAULT_EMAIL = 'testing@gmail.com';
const DEFAULT_PASSWORD = 'testing123';
const SEED_TAG = 'RESTRICTED_TESTING_ADMIN_V1';

const TESTING_ACCESS = Object.freeze({
  // Dashboard is a hidden support permission because the current admin profile
  // route resolves to the Dashboard feature. The sidebar allow-list hides it.
  dashboard: 'view',
  // Read-only clinical support is required by Finance/MRD lookup workflows.
  registration_opd: 'view',
  ipd: 'view',
  pharmacy: 'none',
  billing_finance: 'manage',
  // Profile/Settings lab, imaging and procedure masters are served through the
  // masters_settings service-master APIs, so standalone Lab/Radiology access is
  // intentionally not granted.
  laboratory: 'none',
  radiology: 'none',
  operation_theatre: 'none',
  store_inventory: 'none',
  hr_staff: 'manage',
  reports: 'manage',
  masters_settings: 'manage',
});

const TESTING_ACTIONS = Object.freeze({
  billing_finance: [
    'claim_submit',
    'claim_manage',
    'claim_export',
    'preauth_decide',
    'coverage_reprice',
    'coverage_reprice_commit',
    'pricing_override',
    'settlement',
    'final_clearance',
    'billing_create',
    'billing_edit',
    'billing_delete_charge',
    'billing_apply_discount',
    'billing_finalize',
  ],
  hr_staff: [
    'user_access_manage',
    'payroll_publish',
    'biometric_manage',
  ],
  reports: [
    'mis_export',
    'document_sign',
    'print_identity_verify',
  ],
  masters_settings: [
    'bulk_import_commit',
    'rate_card_approve',
    'rate_card_activate',
    'tariff_mapping_approve',
  ],
});

// This list is independent from the coarse 12-module permission model. It lets
// the delegated admin keep the Admin layout but see/navigate only the requested
// sections. A trailing * is a prefix rule.
const TESTING_SIDEBAR_ACCESS = Object.freeze([
  '/dashboard/admin/profile*',
  '/dashboard/admin/settings*',

  // HR Management and its employee/staff/login-access workflows.
  '/dashboard/hr*',
  '/dashboard/admin/add-staff*',
  '/dashboard/admin/staff*',

  // Finance, Claims and Insurance. Store Purchases is intentionally excluded.
  '/dashboard/admin/income*',
  '/dashboard/admin/expense*',
  '/dashboard/admin/invoices*',
  '/dashboard/admin/invoice-details*',
  '/dashboard/finance*',

  // Reporting / MRD / MIS.
  '/dashboard/mrd*',
  '/dashboard/admin/mis-reports*',
]);

function parseArgs(argv) {
  const args = {
    mongoUri: process.env.MONGO_URI || '',
    database: process.env.DB_NAME || '',
    hospitalId: process.env.HOSPITAL_ID || DEFAULT_HOSPITAL_ID,
    email: DEFAULT_EMAIL,
    password: DEFAULT_PASSWORD,
    dryRun: false,
    preserveExisting: true,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-preserve-existing') args.preserveExisting = false;
    else if (arg.startsWith('--mongo-uri=')) args.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg.startsWith('--database=')) args.database = arg.slice('--database='.length);
    else if (arg.startsWith('--hospital-id=')) args.hospitalId = arg.slice('--hospital-id='.length);
    else if (arg.startsWith('--email=')) args.email = arg.slice('--email='.length).trim().toLowerCase();
    else if (arg.startsWith('--password=')) args.password = arg.slice('--password='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.mongoUri) throw new Error('MONGO_URI is required');
  if (!ObjectId.isValid(args.hospitalId)) throw new Error(`Invalid hospital id: ${args.hospitalId}`);
  if (!args.email) throw new Error('Email is required');
  if (!args.password) throw new Error('Password is required');

  return args;
}

function accessRank(value) {
  return ACCESS_ORDER[normalizeAccess(value)] ?? 0;
}

function preservePermissionsFor(user) {
  const now = new Date();

  // IMPORTANT: use the legacy/effective normalization once during migration.
  // That reproduces what /auth/me currently exposes to the sidebar, including
  // role-default fallbacks for missing/legacy rows. We then persist the result
  // and enable strict enforcement so the backend and sidebar cannot disagree.
  const rows = normalizeFeaturePermissions(
    Array.isArray(user.modulePermissions) ? user.modulePermissions : [],
    user.role,
    { grantedAt: user.createdAt || now }
  );

  const byModule = new Map(rows.map((row) => [row.moduleKey, { ...row }]));

  // dashboard_access is legacy, but if it contains an entitlement that somehow
  // fell out of modulePermissions we only ever ADD view access; never reduce an
  // existing permission. This preserves old/current sidebar access during the
  // restricted-admin rollout.
  for (const legacyKey of Array.isArray(user.dashboard_access) ? user.dashboard_access : []) {
    const moduleKey = toMainFeatureKey(legacyKey);
    const row = byModule.get(moduleKey);
    if (row && accessRank(row.access) < accessRank('view')) {
      row.access = 'view';
      row.updatedAt = now;
    }
  }

  return MAIN_FEATURES.map(({ key }) => byModule.get(key));
}

function testingPermissions(grantedBy) {
  const now = new Date();
  return MAIN_FEATURES.map(({ key }) => ({
    moduleKey: key,
    access: TESTING_ACCESS[key] || 'none',
    actions: Array.from(new Set(TESTING_ACTIONS[key] || [])),
    ...(grantedBy ? { grantedBy } : {}),
    grantedAt: now,
    updatedAt: now,
  }));
}

async function resolveHospital(db, hospitalId) {
  const hospitals = db.collection('hospitals');
  const byId = await hospitals.findOne({ _id: new ObjectId(hospitalId) });
  if (byId) return byId;

  const byCode = await hospitals.findOne({ hospitalID: DEFAULT_HOSPITAL_CODE });
  if (byCode) return byCode;

  throw new Error(`Hospital not found for ObjectId ${hospitalId} or code ${DEFAULT_HOSPITAL_CODE}`);
}

async function preserveExistingUsers(users, hospitalId, testingEmail, dryRun) {
  const cursor = users.find({
    hospital_id: hospitalId,
    email: { $ne: testingEmail },
  });
  let scanned = 0;
  let changed = 0;

  for await (const user of cursor) {
    scanned += 1;
    const permissions = preservePermissionsFor(user);
    const dashboardAccess = dashboardAccessFromFeatures(permissions);

    const set = {
      modulePermissions: permissions,
      dashboard_access: dashboardAccess,
      updatedAt: new Date(),
    };

    const normalizedRole = String(user.role || '').trim().toLowerCase();
    const privileged = ['admin', 'mediqliq_super_admin'].includes(normalizedRole);

    // Existing privileged admins retain their historical unrestricted role
    // behaviour. Existing non-admin users are switched to strict enforcement
    // only AFTER their currently-effective sidebar permissions have been fully
    // materialized above, so nothing they can use today is removed.
    if (privileged) {
      if (typeof user.enforceModulePermissions !== 'boolean') {
        set.enforceModulePermissions = false;
      }
    } else {
      set.enforceModulePermissions = true;
    }

    if (!Array.isArray(user.sidebarAccess)) {
      set.sidebarAccess = [];
    }

    if (!dryRun) {
      await users.updateOne({ _id: user._id }, { $set: set });
    }
    changed += 1;
  }

  return { scanned, changed };
}

async function upsertTestingAdmin(db, hospital, args) {
  const users = db.collection('users');
  const now = new Date();
  const existingAdmin = await users.findOne({
    hospital_id: hospital._id,
    role: { $in: ['admin', 'mediqliq_super_admin'] },
    email: { $ne: args.email },
  }, { sort: { createdAt: 1 } });

  const grantedBy = hospital.createdBy || existingAdmin?._id || null;
  const permissions = testingPermissions(grantedBy);
  const passwordHash = await bcrypt.hash(args.password, 12);

  const update = {
    $set: {
      name: 'Testing Admin',
      email: args.email,
      password: passwordHash,
      role: 'admin',
      hospital_id: hospital._id,
      is_active: true,
      enforceModulePermissions: true,
      sidebarAccess: [...TESTING_SIDEBAR_ACCESS],
      modulePermissions: permissions,
      dashboard_access: dashboardAccessFromFeatures(permissions),
      seedTag: SEED_TAG,
      failedLoginAttempts: 0,
      mfa: { enabled: false, recoveryCodes: [] },
      passwordHistory: [],
      passwordChangedAt: now,
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
    $unset: {
      lockedUntil: '',
      resetPasswordToken: '',
      resetPasswordExpire: '',
    },
  };

  if (args.dryRun) {
    const existing = await users.findOne({ email: args.email }, { projection: { _id: 1, role: 1, hospital_id: 1 } });
    return { dryRun: true, existing, permissions };
  }

  const result = await users.updateOne({ email: args.email }, update, { upsert: true });
  const user = await users.findOne({ email: args.email }, {
    projection: {
      password: 0,
      passwordHistory: 0,
      'mfa.secret': 0,
      'mfa.pendingSecret': 0,
      'mfa.recoveryCodes': 0,
    },
  });
  return { result, user };
}

async function main() {
  const args = parseArgs(process.argv);

  try {
    await mongoose.connect(args.mongoUri, {
      serverSelectionTimeoutMS: 15000,
      ...(args.database ? { dbName: args.database } : {}),
    });
    const db = mongoose.connection.db;
    const hospital = await resolveHospital(db, args.hospitalId);
    const users = db.collection('users');

    console.log(`Database: ${db.databaseName}`);
    console.log(`Hospital: ${hospital.hospitalName || hospital.name || hospital._id} (${hospital._id})`);
    console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'WRITE'}`);

    if (args.preserveExisting) {
      const preservation = await preserveExistingUsers(users, hospital._id, args.email, args.dryRun);
      console.log(`Existing users preserved/top-up checked: ${preservation.scanned}`);
    } else {
      console.log('Existing-user preservation skipped by --no-preserve-existing');
    }

    const seeded = await upsertTestingAdmin(db, hospital, args);

    console.log('');
    console.log('Restricted testing admin');
    console.log(`  Email: ${args.email}`);
    console.log(`  Password: ${args.password}`);
    console.log('  Role: admin (delegated/restricted)');
    console.log('  Visible sections: Profile & Settings; HR Management; Finance/Claims/Insurance; MRD/MIS');
    console.log(`  Navigation rules: ${TESTING_SIDEBAR_ACCESS.length}`);
    console.log(`  Result: ${args.dryRun ? 'not written (dry run)' : (seeded.result?.upsertedCount ? 'created' : 'updated')}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Restricted testing-admin seed failed:', error);
  process.exitCode = 1;
});
