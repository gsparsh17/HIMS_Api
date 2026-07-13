/**
 * ABDM onboarding schema migration.
 *
 * Dry-run by default:
 *   npm run abdm:migrate
 * Apply changes:
 *   npm run abdm:migrate -- --apply
 */
require('dotenv').config({ path: `${__dirname}/../.env` });
const mongoose = require('mongoose');
const AbdmFacility = require('../models/AbdmFacility');
const Hospital = require('../models/Hospital');
const Patient = require('../models/Patient');

const apply = process.argv.includes('--apply');

function normalizeHfrStatus(value) {
  const status = String(value || '').toUpperCase();
  if (['APPROVED', 'PENDING', 'SUBMITTED', 'REJECTED', 'RECEIVED'].includes(status)) return status;
  return 'UNKNOWN';
}

function normalizeLinkageStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'LINKED') return 'LINKED';
  if (['PENDING', 'SOFTWARE_LINKAGE_PENDING'].includes(status)) return 'PENDING';
  if (status === 'FAILED') return 'FAILED';
  return 'NOT_STARTED';
}

function onboardingState(facility) {
  if (facility.onboardingStatus && facility.onboardingStatus !== 'NOT_CONFIGURED') return facility.onboardingStatus;
  if (facility.connector?.status === 'ACTIVE') return 'CONNECTOR_ACTIVE';
  if (facility.abdm?.linkageStatus === 'LINKED' && facility.abdm?.hipId) return 'HIP_VERIFIED';
  if (facility.hfr?.status === 'APPROVED') return 'FACILITY_VERIFIED';
  if (facility.hfr?.facilityId) return 'FACILITY_ID_RECEIVED';
  return 'NOT_CONFIGURED';
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`ABDM v2 migration mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  const facilities = await AbdmFacility.find({}).select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');
  let changedFacilities = 0;
  for (const facility of facilities) {
    const legacyHipId = facility.abdm?.hipId || facility.facilityId;
    const legacyHfrId = facility.hfr?.facilityId || facility.metadata?.hfrFacilityId || facility.facilityId;
    const legacyName = facility.hfr?.facilityName || facility.facilityName || facility.abdm?.hipName;
    facility.hfr = {
      ...(facility.hfr?.toObject?.() || facility.hfr || {}),
      facilityId: legacyHfrId,
      facilityName: legacyName,
      status: normalizeHfrStatus(facility.hfr?.status || facility.hfrStatus)
    };
    facility.abdm = {
      ...(facility.abdm?.toObject?.() || facility.abdm || {}),
      bridgeId: facility.abdm?.bridgeId || facility.bridgeId || process.env.ABDM_BRIDGE_ID,
      hipId: legacyHipId,
      hipName: facility.abdm?.hipName || legacyName,
      environment: facility.abdm?.environment || facility.environment || process.env.ABDM_ENV || 'sandbox',
      linkageStatus: normalizeLinkageStatus(facility.abdm?.linkageStatus || facility.softwareLinkageStatus),
      active: facility.abdm?.active ?? normalizeLinkageStatus(facility.softwareLinkageStatus) === 'LINKED'
    };
    facility.tenantCode = facility.tenantCode || String(legacyHipId || facility._id).replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
    facility.onboardingStatus = onboardingState(facility);

    if (!facility.hospital && facility.tenantCode) {
      // Link only when there is one unambiguous matching hospital.
      // eslint-disable-next-line no-await-in-loop
      const matches = await Hospital.find({
        $or: [{ tenantCode: facility.tenantCode }, { hospitalID: facility.tenantCode }]
      }).limit(2);
      if (matches.length === 1) {
        facility.hospital = matches[0]._id;
        matches[0].abdmFacility = facility._id;
        if (apply) await matches[0].save();
      }
    }

    changedFacilities += 1;
    console.log(`[facility] ${facility._id}: HFR=${facility.hfr.facilityId || '-'} HIP=${facility.abdm.hipId || '-'} state=${facility.onboardingStatus}`);
    if (apply) await facility.save();
  }

  const duplicateAbhaNumbers = await Patient.aggregate([
    { $match: { 'abha.number': { $type: 'string', $ne: '' } } },
    { $group: { _id: '$abha.number', count: { $sum: 1 }, patients: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  const duplicateAbhaAddresses = await Patient.aggregate([
    { $match: { 'abha.address': { $type: 'string', $ne: '' } } },
    { $group: { _id: { $toLower: '$abha.address' }, count: { $sum: 1 }, patients: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } }
  ]);

  console.log(`\nFacilities inspected: ${changedFacilities}`);
  console.log(`Duplicate ABHA numbers requiring manual reconciliation: ${duplicateAbhaNumbers.length}`);
  console.log(`Duplicate ABHA addresses requiring manual reconciliation: ${duplicateAbhaAddresses.length}`);
  if (duplicateAbhaNumbers.length) console.log(JSON.stringify(duplicateAbhaNumbers, null, 2));
  if (duplicateAbhaAddresses.length) console.log(JSON.stringify(duplicateAbhaAddresses, null, 2));
  if (!apply) console.log('\nNo database records were changed. Re-run with --apply after reviewing the output and taking a backup.');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
