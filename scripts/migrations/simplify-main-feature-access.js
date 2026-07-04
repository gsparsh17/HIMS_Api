/*
 * Converts the earlier granular modulePermissions rows into the main feature
 * permissions used by Staff Login & Feature Access.
 *
 * Usage:
 *   node scripts/migrations/simplify-main-feature-access.js --dry-run
 *   node scripts/migrations/simplify-main-feature-access.js
 *
 * Set MONGODB_URI before running. Always run against staging first.
 */
require('dotenv').config();  // <-- ADD THIS LINE

const mongoose = require('mongoose');
const User = require('../../models/User');
const {
  normalizeFeaturePermissions,
  dashboardAccessFromFeatures,
  effectiveMainFeaturePermissions
} = require('../../utils/mainFeatureAccess');

const dryRun = process.argv.includes('--dry-run');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({});
  let changed = 0;

  for (const user of users) {
    const next = normalizeFeaturePermissions(user.modulePermissions, user.role, { grantedAt: user.updatedAt || user.createdAt || new Date() });
    const before = JSON.stringify((user.modulePermissions || []).map((row) => ({ moduleKey: row.moduleKey, access: row.access })));
    const after = JSON.stringify(next.map((row) => ({ moduleKey: row.moduleKey, access: row.access })));
    if (before === after) continue;

    changed += 1;
    if (!dryRun) {
      user.modulePermissions = next;
      user.dashboard_access = dashboardAccessFromFeatures(next);
      await user.save();
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${user.email}:`, effectiveMainFeaturePermissions({ ...user.toObject(), modulePermissions: next }).map((row) => `${row.moduleKey}:${row.access}`).join(', '));
  }

  console.log(`${dryRun ? 'Would update' : 'Updated'} ${changed} user account(s).`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});