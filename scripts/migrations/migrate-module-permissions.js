/*
 * Usage: node scripts/migrations/migrate-module-permissions.js --apply
 * Default is dry-run. This migration never grants Edit or sensitive actions
 * from legacy dashboard_access; an administrator must approve those explicitly.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../../models/User');

const DASHBOARD_MAP = {
  ipd: ['ipd.patient_file','ipd.vitals','ipd.initial_assessment.doctor','ipd.initial_assessment.nursing','ipd.medication_chart','ipd.rounds'],
  pharmacy: ['pharmacy.pos','pharmacy.returns','pharmacy.clearance','pharmacy.ledger'],
  employees: ['hr.employees'], medicine: ['masters.medicine'], lab: ['masters.lab'], radiology: ['masters.radiology'], charges: ['masters.charges'], reports: ['reports.exports'], users: ['users.access'], imports: ['imports']
};
const apply = process.argv.includes('--apply');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const users = await User.find({ $or: [{ modulePermissions: { $exists: false } }, { modulePermissions: { $size: 0 } }] });
  let changed = 0;
  for (const user of users) {
    const modules = new Set();
    for (const legacy of user.dashboard_access || []) for (const key of DASHBOARD_MAP[legacy] || [legacy]) modules.add(key);
    const permissions = [...modules].map((moduleKey) => ({ moduleKey, access: 'view', actions: [], grantedBy: null, grantedAt: new Date(), updatedAt: new Date() }));
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} ${user.email}: ${permissions.map((p) => `${p.moduleKey}=view`).join(', ') || 'no mapping'}`);
    if (apply && permissions.length) { user.modulePermissions = permissions; await user.save(); changed += 1; }
  }
  console.log(`${apply ? 'Updated' : 'Would update'} ${changed || users.length} user(s). Edit and sensitive permissions remain manual.`);
  await mongoose.disconnect();
}
run().catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
