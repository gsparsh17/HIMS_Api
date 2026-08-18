#!/usr/bin/env node
'use strict';

/**
 * Follow-up migration: grant the Admin Pharmacy Finance workspace to hospital
 * admins, while explicitly leaving testing@gmail.com unchanged.
 *
 * Usage (from HIMS_Api-main):
 *   node scripts/followup-enable-admin-pharmacy-finance.js --dry-run
 *   node scripts/followup-enable-admin-pharmacy-finance.js
 *
 * Optional:
 *   --hospital-id=<ObjectId>
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const DEFAULT_HOSPITAL_ID = '69a697c0df37f940dd7906ce';
const EXCLUDED_EMAIL = 'testing@gmail.com';
const EXCLUDED_SEED_TAG = 'RESTRICTED_TESTING_ADMIN_V1';
const SIDEBAR_RULE = '/dashboard/admin/finance/pharmacy*';
const REQUIRED_ACTIONS = ['pharmacy_finance_access', 'billing_edit', 'settlement'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const hospitalArg = args.find((arg) => arg.startsWith('--hospital-id='));
const hospitalId = (hospitalArg ? hospitalArg.split('=').slice(1).join('=') : null)
  || process.env.HOSPITAL_ID
  || DEFAULT_HOSPITAL_ID;

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function accessRank(value) {
  return ({ none: 0, view: 1, manage: 2, edit: 2 })[String(value || 'none').toLowerCase()] || 0;
}

function withAdminPharmacyFinance(user) {
  const now = new Date();
  const permissions = Array.isArray(user.modulePermissions)
    ? user.modulePermissions.map((permission) => ({ ...permission }))
    : [];

  let finance = permissions.find((permission) => permission.moduleKey === 'billing_finance');
  if (!finance) {
    finance = {
      moduleKey: 'billing_finance',
      access: 'manage',
      actions: [],
      grantedBy: user._id,
      grantedAt: now,
      updatedAt: now,
    };
    permissions.push(finance);
  }

  if (accessRank(finance.access) < accessRank('manage')) finance.access = 'manage';
  finance.actions = unique([...(finance.actions || []), ...REQUIRED_ACTIONS]);
  finance.updatedAt = now;
  if (!finance.grantedAt) finance.grantedAt = now;
  if (!finance.grantedBy) finance.grantedBy = user._id;

  const dashboardAccess = unique([...(user.dashboard_access || []), 'billing_finance']);

  // sidebarAccess is an allow-list only when it is non-empty. Do not create an
  // allow-list for legacy unrestricted admins; doing so would accidentally
  // hide their other Admin sidebar items. If a non-testing delegated admin
  // already has an allow-list, extend it with the new Admin Finance prefix.
  const currentSidebar = Array.isArray(user.sidebarAccess) ? user.sidebarAccess : undefined;
  const sidebarAccess = currentSidebar && currentSidebar.length
    ? unique([...currentSidebar, SIDEBAR_RULE])
    : currentSidebar;

  return { modulePermissions: permissions, dashboard_access: dashboardAccess, sidebarAccess, updatedAt: now };
}

async function main() {
  if (!mongoose.Types.ObjectId.isValid(hospitalId)) {
    throw new Error(`Invalid hospital id: ${hospitalId}`);
  }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI (or MONGODB_URI) is required in the backend environment.');

  await mongoose.connect(uri);

  const admins = await User.find({
    hospital_id: new mongoose.Types.ObjectId(hospitalId),
    role: 'admin',
  })
    .select('_id name email role seedTag enforceModulePermissions dashboard_access modulePermissions sidebarAccess')
    .lean();

  const eligible = [];
  const skipped = [];
  for (const admin of admins) {
    const email = String(admin.email || '').trim().toLowerCase();
    if (email === EXCLUDED_EMAIL || admin.seedTag === EXCLUDED_SEED_TAG) {
      skipped.push(admin);
    } else {
      eligible.push(admin);
    }
  }

  console.log(`Hospital: ${hospitalId}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log(`Admin accounts found: ${admins.length}`);
  console.log(`Eligible admin accounts: ${eligible.length}`);
  console.log(`Explicitly excluded: ${skipped.map((user) => user.email).join(', ') || 'none'}`);

  for (const admin of eligible) {
    const next = withAdminPharmacyFinance(admin);
    const finance = next.modulePermissions.find((permission) => permission.moduleKey === 'billing_finance');
    console.log(`\n${admin.email}`);
    console.log(`  billing_finance -> ${finance.access}`);
    console.log(`  ensured actions -> ${REQUIRED_ACTIONS.join(', ')}`);
    console.log(`  sidebar allow-list -> ${next.sidebarAccess?.length ? `extended with ${SIDEBAR_RULE}` : 'not used (legacy/unrestricted navigation preserved)'}`);

    if (!dryRun) {
      const update = {
        modulePermissions: next.modulePermissions,
        dashboard_access: next.dashboard_access,
        updatedAt: next.updatedAt,
      };
      if (next.sidebarAccess !== undefined) update.sidebarAccess = next.sidebarAccess;

      await User.collection.updateOne(
        { _id: admin._id, email: { $ne: EXCLUDED_EMAIL } },
        { $set: update }
      );
    }
  }

  // Final safety assertion: the requested testing account is never modified.
  const testing = await User.findOne({
    hospital_id: new mongoose.Types.ObjectId(hospitalId),
    email: EXCLUDED_EMAIL,
  }).select('_id email seedTag sidebarAccess modulePermissions updatedAt').lean();

  console.log(`\nSafety check: ${EXCLUDED_EMAIL} ${testing ? 'exists and was intentionally skipped' : 'not found in this hospital'}.`);
  console.log(dryRun ? 'Dry run complete; no database changes were written.' : 'Follow-up migration complete.');
}

main()
  .catch((error) => {
    console.error('\nMigration failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) { /* noop */ }
  });
