#!/usr/bin/env node
'use strict';

/**
 * Remove Amit Verma's seeded/operational IPD journey so the corrected fixture
 * can be run again. The Patient master record is deliberately PRESERVED.
 *
 * DRY RUN by default.
 * Execute with:
 *   node scripts/delete-amit-verma-complete-flow.js --execute --confirm DELETE_AMIT_VERMA_COMPLETE_FLOW
 */

require('dotenv').config();
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Types;
const AMIT_PATIENT_ID = new ObjectId('6a4a7b0eda2544aff0921dd9');
const AMIT_UHID = 'AZ4967-DEMP6465-2607';
const IPD_TAG = 'FLOW_FIXTURE_IPD_AMIT_V1';
const CONFIRM_TEXT = 'DELETE_AMIT_VERMA_COMPLETE_FLOW';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const confirmIndex = args.indexOf('--confirm');
const confirmArg = confirmIndex >= 0 ? args[confirmIndex + 1] : null;

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error('Missing MONGO_URI / MONGODB_URI / MONGO_URL in .env');
  process.exit(1);
}

const OPERATIONAL_COLLECTIONS = [
  'appointments',
  'vitals',
  'prescriptions',
  'labrequests',
  'labreports',
  'radiologyrequests',
  'radiologyreports',
  'procedurerequests',
  'bills',
  'invoices',
  'financialtransactions',
  'deskcheckouts',
  'sales',
  'pharmacyledgerentries',
  'pharmacyledgersettlements',
  'ipdaccommodationsegments',
  'ipdrounds',
  'ipdvitals',
  'nursingnotes',
  'ipdmedicationcharts',
  'ipdpatientmedicinestocks',
  'ipdcharges',
  'dischargesummaries',
  'patientadvanceledgers',
  'sponsorledgerentries',
  'coverageutilizations',
  'packageutilizations',
  'approvalrequests'
];

function patientOrAdmissionFilter(patientId, admissionIds) {
  const or = [
    { _testScenario: IPD_TAG },
    { patientId },
    { patient_id: patientId },
    { patient: patientId }
  ];
  if (admissionIds.length) {
    or.push(
      { admissionId: { $in: admissionIds } },
      { admission_id: { $in: admissionIds } },
      { encounterId: { $in: admissionIds } },
      { encounter_id: { $in: admissionIds } }
    );
  }
  return { $or: or };
}

async function main() {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  const patient = await db.collection('patients').findOne({
    $or: [
      { _id: AMIT_PATIENT_ID },
      { uhid: AMIT_UHID },
      { patientId: AMIT_UHID }
    ]
  });

  if (!patient) throw new Error(`Amit Verma patient master not found (${AMIT_UHID}).`);

  const patientId = patient._id;
  const admissions = await db.collection('ipdadmissions').find({
    $or: [
      { patientId },
      { patient_id: patientId },
      { _testScenario: IPD_TAG }
    ]
  }).toArray();
  const admissionIds = admissions.map((row) => row._id);
  const baseFilter = patientOrAdmissionFilter(patientId, admissionIds);

  const collectionNames = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name));
  const counts = {};
  for (const name of OPERATIONAL_COLLECTIONS) {
    if (!collectionNames.has(name)) continue;
    counts[name] = await db.collection(name).countDocuments(baseFilter);
  }
  counts.ipdadmissions = admissions.length;

  const sales = collectionNames.has('sales')
    ? await db.collection('sales').find(baseFilter).toArray()
    : [];

  const stockRestore = new Map();
  for (const sale of sales) {
    if (['Cancelled', 'Canceled', 'FullyReturned'].includes(String(sale.status || ''))) continue;
    for (const item of sale.items || []) {
      const batchId = item.batch_id || item.batchId;
      const qty = Number(item.quantity_base_units ?? item.quantityBaseUnits ?? item.quantity ?? 0);
      if (!batchId || !(qty > 0)) continue;
      const key = String(batchId);
      stockRestore.set(key, (stockRestore.get(key) || 0) + qty);
    }
  }

  console.log(`Patient master preserved: ${patient._id} | ${patient.uhid || patient.patientId} | ${[patient.first_name, patient.last_name].filter(Boolean).join(' ')}`);
  console.log(`Admissions to remove: ${admissionIds.length}`);
  console.table(Object.entries(counts).filter(([, count]) => count > 0).map(([collection, count]) => ({ collection, count })));
  if (stockRestore.size) {
    console.log('Medicine batch quantities to restore:');
    console.table([...stockRestore.entries()].map(([batchId, quantity]) => ({ batchId, quantity })));
  }

  if (!EXECUTE) {
    console.log('\nDRY RUN COMPLETE. No data was changed.');
    console.log(`To execute: node scripts/delete-amit-verma-complete-flow.js --execute --confirm ${CONFIRM_TEXT}`);
    return;
  }

  if (confirmArg !== CONFIRM_TEXT) {
    throw new Error(`Execution requires: --confirm ${CONFIRM_TEXT}`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Restore stock consumed by Amit's pharmacy sale before deleting the sale.
      for (const [batchId, quantity] of stockRestore.entries()) {
        await db.collection('medicinebatches').updateOne(
          { _id: new ObjectId(batchId) },
          { $inc: { quantity_base_units: quantity, quantity } },
          { session }
        );
      }

      // Release any bed/room linked to Amit's removed admission(s).
      const bedIds = admissions.map((row) => row.bedId).filter(Boolean);
      const roomIds = admissions.map((row) => row.roomId).filter(Boolean);
      if (bedIds.length && collectionNames.has('beds')) {
        await db.collection('beds').updateMany(
          {
            _id: { $in: bedIds },
            $or: [
              { currentAdmissionId: { $in: admissionIds } },
              { currentAdmissionId: { $exists: false } },
              { currentAdmissionId: null }
            ]
          },
          {
            $set: { status: 'Available' },
            $unset: {
              currentAdmissionId: '', reservedTransferId: '', reservationExpiresAt: '',
              cleaningStartedAt: '', cleaningCompletedAt: '', cleaningNote: ''
            }
          },
          { session }
        );
      }
      if (roomIds.length && collectionNames.has('rooms')) {
        await db.collection('rooms').updateMany(
          {
            _id: { $in: roomIds },
            $or: [
              { assigned_patient_id: patientId },
              { assigned_patient_id: { $exists: false } },
              { assigned_patient_id: null }
            ]
          },
          { $set: { status: 'Available' }, $unset: { assigned_patient_id: '' } },
          { session }
        );
      }

      for (const name of OPERATIONAL_COLLECTIONS) {
        if (!collectionNames.has(name)) continue;
        await db.collection(name).deleteMany(baseFilter, { session });
      }

      await db.collection('ipdadmissions').deleteMany({
        $or: [
          { _id: { $in: admissionIds } },
          { patientId },
          { patient_id: patientId },
          { _testScenario: IPD_TAG }
        ]
      }, { session });

      // Keep the Patient master, but clear encounter-derived cache/summary fields
      // so the next fixture starts from a clean operational state.
      await db.collection('patients').updateOne(
        { _id: patientId },
        {
          $set: {
            pharmacy_outstanding_balance: 0,
            pharmacy_advance_balance: 0,
            active_admissions: [],
            updated_at: new Date()
          },
          $unset: {
            last_pharmacy_visit: '',
            last_pharmacy_transaction: '',
            lastCoveragePreference: ''
          }
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  console.log('\nDELETE COMPLETE');
  console.log(`Amit Verma operational IPD records removed. Patient master ${patientId} was preserved.`);
  console.log('You can now run the corrected seed-two-patient-complete-flows.js fixture.');
}

main()
  .catch((error) => {
    console.error('\nDELETE FAILED:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });
