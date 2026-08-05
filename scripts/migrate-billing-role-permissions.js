#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Hospital = require('../models/Hospital');

const argv = process.argv.slice(2);
const valueArg = (name) => {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const apply = argv.includes('--apply');
// Backward-compatible alias: the old --revoke-frontdesk flag now applies only
// to the generic "staff" role. Registrar and receptionist are never revoked.
const revokeStaff = argv.includes('--revoke-staff') || argv.includes('--revoke-frontdesk');
const hospitalId = valueArg('--hospital-id');

const BILLING_ACTIONS = [
  'billing_create',
  'billing_edit',
  'billing_delete_charge',
  'billing_apply_discount',
  'billing_finalize',
  'claim_submit',
  'claim_manage',
  'claim_export',
  'preauth_decide',
  'coverage_reprice',
  'coverage_reprice_commit',
  'settlement',
  'final_clearance',
  'pricing_override'
];
const GUARANTEED_BILLING_ROLES = new Set([
  'accountant',
  'insurance_desk',
  'registrar',
  'receptionist'
]);
const CLINICAL_ROLES = new Set([
  'doctor', 'nurse', 'pathology_staff', 'radiology_staff', 'ot_staff',
  'bed_manager', 'housekeeping', 'hr', 'hr_manager', 'store',
  'store_manager', 'inventory_manager', 'equipment_manager'
]);
const OPTIONAL_STAFF_ROLES = new Set(['staff']);

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function normalizeRow(row = {}) {
  return {
    moduleKey: String(row.moduleKey || ''),
    access: row.access === 'edit' ? 'manage' : (row.access || 'none'),
    actions: Array.isArray(row.actions) ? [...new Set(row.actions.filter(Boolean))] : [],
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt || new Date(),
    updatedAt: new Date()
  };
}

function desiredPermissions(user) {
  const role = normalizeRole(user.role);
  const rows = (user.modulePermissions || []).map((row) => normalizeRow(row.toObject ? row.toObject() : row));
  let billing = rows.find((row) => row.moduleKey === 'billing_finance');
  if (!billing) {
    billing = { moduleKey: 'billing_finance', access: 'none', actions: [], grantedAt: new Date(), updatedAt: new Date() };
    rows.push(billing);
  }

  if (GUARANTEED_BILLING_ROLES.has(role)) {
    billing.access = 'manage';
    billing.actions = [...new Set([...billing.actions, ...BILLING_ACTIONS])];
  } else if (CLINICAL_ROLES.has(role) || (revokeStaff && OPTIONAL_STAFF_ROLES.has(role))) {
    billing.access = 'none';
    billing.actions = billing.actions.filter((action) => !BILLING_ACTIONS.includes(action));
  }
  billing.updatedAt = new Date();

  const dashboard = new Set((user.dashboard_access || []).map(String));
  if (billing.access === 'none') dashboard.delete('billing_finance');
  else dashboard.add('billing_finance');

  return { modulePermissions: rows, dashboard_access: [...dashboard] };
}

function comparable(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof mongoose.Types.ObjectId) return String(item);
    if (item instanceof Date) return undefined;
    return item;
  });
}

async function main() {
  if (!hospitalId || !mongoose.isValidObjectId(hospitalId)) {
    throw new Error('Pass a valid --hospital-id=<ObjectId>');
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const hospital = await Hospital.findById(hospitalId).select('hospitalName name hospitalID registryNo').lean();
  if (!hospital) throw new Error('Hospital not found');

  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'PREVIEW',
    hospital,
    policy: {
      guaranteedBillingRoles: [...GUARANTEED_BILLING_ROLES],
      clinicalRolesRevoked: [...CLINICAL_ROLES],
      staffRoleRevoked: revokeStaff ? [...OPTIONAL_STAFF_ROLES] : [],
      note: 'Registrar and receptionist always receive manage access plus billing actions. They are never revoked by this migration.'
    }
  }, null, 2));

  const users = await User.find({ hospital_id: hospitalId }).sort({ role: 1, email: 1 });
  const summary = {
    scanned: users.length,
    candidates: 0,
    updated: 0,
    unchanged: 0,
    guaranteedGranted: 0,
    clinicalRevoked: 0,
    staffRevoked: 0
  };

  for (const user of users) {
    const next = desiredPermissions(user);
    const current = {
      modulePermissions: (user.modulePermissions || []).map((row) => normalizeRow(row.toObject ? row.toObject() : row)),
      dashboard_access: [...(user.dashboard_access || [])]
    };
    if (comparable(current) === comparable(next)) {
      summary.unchanged += 1;
      continue;
    }
    summary.candidates += 1;
    const role = normalizeRole(user.role);
    if (GUARANTEED_BILLING_ROLES.has(role)) summary.guaranteedGranted += 1;
    if (CLINICAL_ROLES.has(role)) summary.clinicalRevoked += 1;
    if (revokeStaff && OPTIONAL_STAFF_ROLES.has(role)) summary.staffRevoked += 1;
    console.log(`${apply ? 'UPDATE' : 'WOULD UPDATE'} ${user.email} (${role}) billing=${next.modulePermissions.find((row) => row.moduleKey === 'billing_finance')?.access}`);
    if (apply) {
      await User.updateOne({ _id: user._id, hospital_id: hospitalId }, { $set: next });
      summary.updated += 1;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!apply) console.log('Preview only. Re-run with --apply after review.');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await mongoose.connection.close().catch(() => {}); });
