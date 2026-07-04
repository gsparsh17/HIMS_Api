/*
 * Backfills the additive IPD medication-flow fields introduced by this patch.
 * Default is dry-run. Add --apply only after reviewing the output.
 *
 * Usage:
 *   node scripts/backfill-ipd-medication-flow.js
 *   node scripts/backfill-ipd-medication-flow.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const { resolveDoseQtyBaseUnits, calculateMedicationRequiredBaseUnits } = require('../services/ipdMedicationFlow.service');

const connectionString = process.env.MONGO_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
const apply = process.argv.includes('--apply');

async function run() {
  if (!connectionString) throw new Error('Set MONGO_URI, MONGODB_URI, or DATABASE_URL before running this script.');
  await mongoose.connect(connectionString);

  const charts = await IPDMedicationChart.find({
    $or: [
      { hospitalId: { $exists: false } },
      { hospitalId: null },
      { doseQtyBaseUnits: { $exists: false } },
      { requiredQtyBaseUnits: { $exists: false } }
    ]
  }).lean();

  console.log(`${apply ? 'Applying' : 'Dry run:'} ${charts.length} IPD medication chart(s) need review.`);
  const admissionCache = new Map();
  let changed = 0;

  for (const chart of charts) {
    const admissionId = String(chart.admissionId || '');
    let admission = admissionCache.get(admissionId);
    if (admission === undefined) {
      admission = await IPDAdmission.findById(chart.admissionId).select('hospitalId').lean();
      admissionCache.set(admissionId, admission || null);
    }

    const doseQtyBaseUnits = Number(chart.doseQtyBaseUnits) > 0
      ? Number(chart.doseQtyBaseUnits)
      : resolveDoseQtyBaseUnits({ dosage: chart.dosage });
    const requiredQtyBaseUnits = Number(chart.requiredQtyBaseUnits) >= 0
      ? Number(chart.requiredQtyBaseUnits)
      : calculateMedicationRequiredBaseUnits({
        dosage: chart.dosage,
        doseQtyBaseUnits,
        frequency: chart.frequency,
        duration: chart.duration || 1,
        durationUnit: chart.durationUnit || 'Days'
      });

    const update = {
      doseQtyBaseUnits,
      requiredQtyBaseUnits
    };
    if (!chart.hospitalId && admission?.hospitalId) update.hospitalId = admission.hospitalId;

    console.log(`${chart._id}:`, update);
    if (apply) await IPDMedicationChart.updateOne({ _id: chart._id }, { $set: update });
    changed += 1;
  }

  console.log(`${apply ? 'Updated' : 'Would update'} ${changed} chart(s).`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Backfill failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
