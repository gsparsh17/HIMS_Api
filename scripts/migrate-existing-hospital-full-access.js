/**
 * Hospital/HIMS DB migration for the existing Test Hospital.
 * Run this against the hospital's own MONGO_URI (never the Master Atlas URI).
 *
 * Defaults correspond to the records supplied for this deployment. Override if the local ObjectId differs:
 *   MIGRATION_HOSPITAL_ID=69a697c0df37f940dd7906ce
 *   MIGRATION_HOSPITAL_CODE=AZ4967
 *   MIGRATION_MASTER_HOSPITAL_ID=69a697c0df37f940dd7906ce
 *   MIGRATION_MASTER_LICENSE_ID=69e5ea929de2a7177ab5fa51
 *   MIGRATION_LICENSE_KEY=HOSP-LAQD-93ZG-OSS8
 *   MIGRATION_LICENSE_EXPIRES_AT=2027-04-20T08:57:54.922Z
 *   MIGRATION_FRONTEND_URL=https://hospital.example.com
 *   MIGRATION_BACKEND_URL=https://api-hospital.example.com
 *   MIGRATION_DATABASE_NAME=mediqliq_test_hospital
 *   MIGRATION_DRY_RUN=true
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const LegacyLicense = require('../models/License');
const LicenseSnapshot = require('../models/LicenseSnapshot');
const { FULL_ACCESS_ENTITLEMENTS } = require('../utils/entitlements');

const HOSPITAL_ID = process.env.MIGRATION_HOSPITAL_ID || '69a697c0df37f940dd7906ce';
const HOSPITAL_CODE = String(process.env.MIGRATION_HOSPITAL_CODE || 'AZ4967').toUpperCase();
const MASTER_HOSPITAL_ID = process.env.MIGRATION_MASTER_HOSPITAL_ID || HOSPITAL_ID;
const MASTER_LICENSE_ID = process.env.MIGRATION_MASTER_LICENSE_ID || '69e5ea929de2a7177ab5fa51';
const LICENSE_KEY = process.env.MIGRATION_LICENSE_KEY || 'HOSP-LAQD-93ZG-OSS8';
const EXPIRES_AT = new Date(process.env.MIGRATION_LICENSE_EXPIRES_AT || '2027-04-20T08:57:54.922Z');
const DRY_RUN = String(process.env.MIGRATION_DRY_RUN || '').toLowerCase() === 'true';

async function findHospital() {
  if (mongoose.Types.ObjectId.isValid(HOSPITAL_ID)) {
    const byId = await Hospital.findById(HOSPITAL_ID);
    if (byId) return byId;
  }
  return Hospital.findOne({ $or: [{ hospitalID: HOSPITAL_CODE }, { registryNo: 'REG-2525' }, { email: 'admin@gmail.com' }] });
}

async function main() {
  await connectDB();
  const hospital = await findHospital();
  if (!hospital) throw new Error('Existing Test Hospital was not found in this HIMS database');

  const now = new Date();
  const deployment = {
    ...(hospital.deployment?.toObject?.() || hospital.deployment || {}),
    frontendUrl: process.env.MIGRATION_FRONTEND_URL ?? hospital.deployment?.frontendUrl ?? '',
    backendUrl: process.env.MIGRATION_BACKEND_URL ?? hospital.deployment?.backendUrl ?? '',
    databaseName: process.env.MIGRATION_DATABASE_NAME ?? hospital.deployment?.databaseName ?? '',
    environment: hospital.deployment?.environment || 'production',
    status: hospital.deployment?.status === 'SUSPENDED' ? 'SUSPENDED' : 'READY',
    provisionedAt: hospital.deployment?.provisionedAt || now
  };

  const snapshot = {
    hospitalId: hospital._id,
    tenantCode: HOSPITAL_CODE,
    masterLicenseId: MASTER_LICENSE_ID,
    key: LICENSE_KEY,
    status: 'active',
    planCode: 'FULL_ACCESS',
    planVersion: 1,
    startsAt: new Date('2026-04-20T08:57:54.930Z'),
    expiresAt: EXPIRES_AT,
    entitlementSnapshot: { ...FULL_ACCESS_ENTITLEMENTS },
    entitlementOverrides: {},
    effectiveEntitlements: { ...FULL_ACCESS_ENTITLEMENTS },
    limits: { patientMediaGb: 100, aiCallsMonthly: null },
    licenseVersion: 1,
    checkedAt: now,
    lastSyncStatus: 'MIGRATED',
    sourceUpdatedAt: now
  };

  console.log('Migration target:', { localHospitalId: String(hospital._id), hospitalID: hospital.hospitalID, tenantCode: HOSPITAL_CODE, masterHospitalId: MASTER_HOSPITAL_ID, masterLicenseId: MASTER_LICENSE_ID, plan: 'FULL_ACCESS', expiresAt: EXPIRES_AT.toISOString(), dryRun: DRY_RUN });
  if (DRY_RUN) return;

  hospital.masterHospitalId = MASTER_HOSPITAL_ID;
  hospital.tenantCode = HOSPITAL_CODE;
  hospital.deployment = deployment;
  await hospital.save();

  await LicenseSnapshot.findOneAndUpdate({ hospitalId: hospital._id }, { $set: snapshot }, { upsert: true, new: true, runValidators: true });

  // Keep the legacy local License collection coherent if the old key exists here.
  const legacy = await LegacyLicense.findOne({ $or: [{ key: LICENSE_KEY }, { hospital: hospital._id }] }).catch(() => null);
  if (legacy) {
    legacy.hospital = hospital._id;
    legacy.plan = 'FULL_ACCESS';
    legacy.features = { ...FULL_ACCESS_ENTITLEMENTS };
    legacy.status = 'active';
    legacy.expiryDate = EXPIRES_AT;
    await legacy.save();
  }

  // Existing unrestricted hospital admins remain unrestricted only inside commercial entitlements.
  await User.updateMany({ hospital_id: hospital._id, role: 'admin' }, { $set: { enforceModulePermissions: false, is_active: true } });

  const verified = await LicenseSnapshot.findOne({ hospitalId: hospital._id }).lean();
  const missing = Object.entries(FULL_ACCESS_ENTITLEMENTS).filter(([key, value]) => value && verified.effectiveEntitlements?.[key] !== true);
  if (verified.masterLicenseId !== MASTER_LICENSE_ID || missing.length) throw new Error(`Verification failed: ${missing.map(([key]) => key).join(', ') || 'license mapping mismatch'}`);
  console.log('SUCCESS: HIMS hospital now has FULL_ACCESS LicenseSnapshot and all hospital admins inherit all purchased features.');
}

main().then(async () => { await mongoose.disconnect(); process.exit(0); }).catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
