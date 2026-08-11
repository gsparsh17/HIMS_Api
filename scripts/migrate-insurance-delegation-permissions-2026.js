#!/usr/bin/env node
'use strict';

/**
 * Insurance workflow delegation migration.
 *
 * Goals:
 *  - keep hospital admins able to perform the full insurance workflow themselves;
 *  - allow Admin + HR to manage module/action delegation;
 *  - make high-risk insurance actions explicit rather than role-default privileges;
 *  - optionally clear existing non-admin insurance delegations for a clean re-assignment.
 *
 * Safe default: PREVIEW ONLY. Pass --apply to write.
 *
 * Examples:
 *   node scripts/migrate-insurance-delegation-permissions-2026.js --hospital-id=<id>
 *   node scripts/migrate-insurance-delegation-permissions-2026.js --hospital-id=<id> --apply
 *   node scripts/migrate-insurance-delegation-permissions-2026.js --hospital-id=<id> --reset-insurance-delegations --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const {
  DELEGABLE_INSURANCE_ACTIONS,
  normalizeRole
} = require('../utils/insuranceWorkflowAuthority');

const HR_ROLES = new Set(['hr', 'hr_manager']);
const ADMIN_ROLES = new Set(['admin', 'mediqliq_super_admin']);
const DELEGATED = new Set(DELEGABLE_INSURANCE_ACTIONS);

function parseArgs(argv) {
  const result = {
    apply: false,
    resetInsuranceDelegations: false,
    hospitalId: null,
    mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || ''
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') result.apply = true;
    else if (arg === '--reset-insurance-delegations') result.resetInsuranceDelegations = true;
    else if (arg.startsWith('--hospital-id=')) result.hospitalId = arg.slice('--hospital-id='.length);
    else if (arg.startsWith('--mongo-uri=')) result.mongoUri = arg.slice('--mongo-uri='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');
  if (!result.hospitalId || !mongoose.isValidObjectId(result.hospitalId)) {
    throw new Error('--hospital-id=<ObjectId> is required');
  }
  return result;
}

function clonePermissions(rows = []) {
  return rows.map((row) => ({
    moduleKey: String(row.moduleKey || ''),
    access: String(row.access || 'none'),
    actions: Array.from(new Set(Array.isArray(row.actions) ? row.actions.map(String) : [])),
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt
  }));
}

function ensureHrAccessManager(rows, now) {
  let hr = rows.find((row) => row.moduleKey === 'hr_staff');
  let changed = false;
  if (!hr) {
    hr = { moduleKey: 'hr_staff', access: 'manage', actions: [], grantedAt: now, updatedAt: now };
    rows.push(hr);
    changed = true;
  }
  if (hr.access !== 'manage') {
    hr.access = 'manage';
    changed = true;
  }
  if (!(hr.actions || []).includes('user_access_manage')) {
    hr.actions = Array.from(new Set([...(hr.actions || []), 'user_access_manage']));
    changed = true;
  }
  if (changed) hr.updatedAt = now;
  return { rows, changed };
}

function removeInsuranceDelegations(rows) {
  for (const row of rows) {
    row.actions = (row.actions || []).filter((action) => !DELEGATED.has(action));
  }
  return rows;
}

function delegatedActions(rows) {
  return Array.from(new Set(
    rows.flatMap((row) => row.actions || []).filter((action) => DELEGATED.has(action))
  )).sort();
}

async function run() {
  const options = parseArgs(process.argv);
  await mongoose.connect(options.mongoUri);
  const hospitalId = new mongoose.Types.ObjectId(options.hospitalId);
  const users = await User.find({ hospital_id: hospitalId }).lean();
  const now = new Date();
  const report = {
    mode: options.apply ? 'APPLY' : 'PREVIEW',
    hospitalId: String(hospitalId),
    usersScanned: users.length,
    hrAccessManagersToUpdate: [],
    existingInsuranceDelegations: [],
    insuranceDelegationsToReset: [],
    writesPlanned: 0,
    writesApplied: 0
  };
  const operations = [];

  for (const user of users) {
    const role = normalizeRole(user.role);
    const before = clonePermissions(user.modulePermissions || []);
    let after = clonePermissions(user.modulePermissions || []);
    let changed = false;

    const beforeDelegations = delegatedActions(before);
    if (beforeDelegations.length) {
      report.existingInsuranceDelegations.push({
        userId: String(user._id),
        email: user.email,
        role,
        actions: beforeDelegations
      });
    }

    if (HR_ROLES.has(role)) {
      const hrResult = ensureHrAccessManager(after, now);
      after = hrResult.rows;
      if (hrResult.changed) {
        changed = true;
        report.hrAccessManagersToUpdate.push({ userId: String(user._id), email: user.email, role });
      }
    }

    if (options.resetInsuranceDelegations && !ADMIN_ROLES.has(role)) {
      const delegated = delegatedActions(after);
      if (delegated.length) {
        after = removeInsuranceDelegations(after);
        changed = true;
        report.insuranceDelegationsToReset.push({
          userId: String(user._id),
          email: user.email,
          role,
          actions: delegated
        });
      }
    }

    if (changed) {
      const dashboardAccess = Array.from(new Set([
        ...(user.dashboard_access || []),
        ...(HR_ROLES.has(role) ? ['hr_staff'] : [])
      ]));
      operations.push({
        updateOne: {
          filter: { _id: user._id, hospital_id: hospitalId },
          update: { $set: { modulePermissions: after, dashboard_access: dashboardAccess, updatedAt: now } }
        }
      });
    }
  }

  report.writesPlanned = operations.length;
  if (options.apply && operations.length) {
    const result = await User.collection.bulkWrite(operations, { ordered: false });
    report.writesApplied = Number(result.modifiedCount || 0);
  }

  console.log(JSON.stringify(report, null, 2));
  if (!options.apply) {
    console.log('\nPREVIEW ONLY: re-run with --apply after reviewing the report.');
  }
  if (!options.resetInsuranceDelegations) {
    console.log('\nExisting delegated insurance actions were preserved. Use --reset-insurance-delegations if you want Admin/HR to re-assign them from a clean slate.');
  }
}

run()
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
