#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');
const firstEmail = String(process.env.SECURITY_BOOTSTRAP_ADMIN_1 || '').trim().toLowerCase();
const secondEmail = String(process.env.SECURITY_BOOTSTRAP_ADMIN_2 || '').trim().toLowerCase();
if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
if (!firstEmail || !secondEmail || firstEmail === secondEmail) throw new Error('Set two distinct SECURITY_BOOTSTRAP_ADMIN_1 and SECURITY_BOOTSTRAP_ADMIN_2 emails');

const BASE = ['privileged_access_request', 'privileged_access_approve', 'break_glass_review', 'abdm_reconciliation_view', 'abdm_reconciliation_manage', 'audit_log_view'];

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({ email: { $in: [firstEmail, secondEmail] } });
  if (users.length !== 2) throw new Error('Both bootstrap admin users must already exist');
  if (users.some((u) => !u.is_active || !['admin', 'mediqliq_super_admin'].includes(u.role))) throw new Error('Both bootstrap users must be active admins');
  if (String(users[0].hospital_id || '') !== String(users[1].hospital_id || '')) throw new Error('Bootstrap admins must belong to the same hospital');

  const preview = users.map((u) => ({ id: String(u._id), email: u.email, hospitalId: String(u.hospital_id), add: BASE.filter((a) => !(u.privilegedActions || []).includes(a)) }));
  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY_RUN', preview }, null, 2));
  if (!APPLY) return;
  if (String(process.env.SECURITY_BOOTSTRAP_CONFIRM || '').toUpperCase() !== 'YES') throw new Error('Set SECURITY_BOOTSTRAP_CONFIRM=YES before --apply');

  for (const user of users) {
    user.privilegedActions = Array.from(new Set([...(user.privilegedActions || []), ...BASE]));
    user.$locals.allowPrivilegedPermissionChange = true;
    user.securityVersion = Number(user.securityVersion || 0) + 1;
    user.sessionRevokedAt = new Date();
    await user.save({ validateBeforeSave: true });
  }
  console.log('Security governance bootstrap complete. Existing sessions for both admins were revoked.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => mongoose.disconnect().catch(() => {}));
