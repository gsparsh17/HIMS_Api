/* Run: node scripts/migrations/phase1FinanceIntegrity.js --dry-run (default)
        node scripts/migrations/phase1FinanceIntegrity.js --apply
   Uses the application's MONGO_URI. Backfills normalizedPhone and source billing states only;
   it does not issue, alter, or re-total historical financial documents. */
require('dotenv').config();
const mongoose = require('mongoose');
const Patient = require('../../models/Patient');
const LabRequest = require('../../models/LabRequest');
const RadiologyRequest = require('../../models/RadiologyRequest');
const ProcedureRequest = require('../../models/ProcedureRequest');
const { normalizeIndianPhone } = require('../../utils/patientDemographics');

const apply = process.argv.includes('--apply');
async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const patients = await Patient.find({ $or: [{ normalizedPhone: { $exists: false } }, { normalizedPhone: '' }] }).select('_id phone').lean();
  const patientOps = patients.map((row) => ({ updateOne: { filter: { _id: row._id }, update: { $set: { normalizedPhone: normalizeIndianPhone(row.phone) } } } }));
  const sources = [LabRequest, RadiologyRequest, ProcedureRequest];
  const report = { mode: apply ? 'APPLY' : 'DRY_RUN', patientsToBackfill: patientOps.length, sources: {} };
  if (apply && patientOps.length) await Patient.bulkWrite(patientOps, { ordered: false });
  for (const Model of sources) {
    const filter = { billingState: { $exists: false } };
    const count = await Model.countDocuments(filter);
    report.sources[Model.modelName] = count;
    if (apply && count) await Model.updateMany(filter, [{ $set: {
      billingIntent: { $cond: ['$is_referred_out', 'EXTERNAL_REFERRAL', 'DEFER_TO_ENCOUNTER'] },
      billingState: { $cond: ['$is_billed', 'INVOICED', 'PENDING_CHARGE'] },
      invoiceIds: { $cond: [{ $ne: ['$invoiceId', null] }, ['$invoiceId'], []] },
      chargeIds: [], billIds: [], billingHistory: [], pricingSnapshot: {}
    } }]);
  }
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}
run().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exit(1); });
