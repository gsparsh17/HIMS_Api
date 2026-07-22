/*
 * One-time migration for the OT, Store, patient-file and digital-signature platform.
 * Usage:
 *   node scripts/migrate-ot-store-document-platform.js --dry-run
 *   node scripts/migrate-ot-store-document-platform.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const IPDConsent = require('../models/IPDConsent');
const OTRequest = require('../models/OTRequest');
const OTSchedule = require('../models/OTSchedule');
const OTStaff = require('../models/OTStaff');
const OTClinicalForm = require('../models/OTClinicalForm');
const StoreItem = require('../models/StoreItem');
const StoreInventoryTransaction = require('../models/StoreInventoryTransaction');

const apply = process.argv.includes('--apply');

async function updateMissingHospital(Model, sourceField, targetField, sourceModel) {
  const cursor = Model.find({ [targetField]: { $exists: false }, [sourceField]: { $ne: null } }).cursor();
  let matched = 0;
  for await (const record of cursor) {
    matched += 1;
    const source = await sourceModel.findById(record[sourceField]).select('hospitalId hospital_id');
    const hospitalId = source?.hospitalId || source?.hospital_id;
    if (apply && hospitalId) await Model.updateOne({ _id: record._id }, { $set: { [targetField]: hospitalId } });
  }
  return matched;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const IPDAdmission = require('../models/IPDAdmission');
  const User = require('../models/User');
  const report = {};
  report.otRequestsMissingHospital = await updateMissingHospital(OTRequest, 'admissionId', 'hospitalId', IPDAdmission);
  report.otSchedulesMissingHospital = await updateMissingHospital(OTSchedule, 'requestId', 'hospitalId', OTRequest);
  report.otStaffMissingHospital = await updateMissingHospital(OTStaff, 'userId', 'hospitalId', User);
  report.consentsMissingHospital = await updateMissingHospital(IPDConsent, 'admissionId', 'hospitalId', IPDAdmission);

  const consentFilter = { $or: [{ scopeKey: { $exists: false } }, { scopeKey: null }, { scopeKey: '' }] };
  report.consentsMissingScopeKey = await IPDConsent.countDocuments(consentFilter);
  if (apply) await IPDConsent.updateMany(consentFilter, { $set: { scopeKey: 'admission', formRevision: 1 } });

  report.storeItemsMissingHospital = await StoreItem.countDocuments({ hospital_id: { $exists: false } });
  report.legacyTransactionsWithoutEventId = await StoreInventoryTransaction.countDocuments({ eventId: { $exists: false } });

  if (apply) {
    const collection = IPDConsent.collection;
    for (const index of await collection.indexes()) {
      if (index.unique && index.key?.admissionId === 1 && index.key?.templateId === 1 && !index.key?.scopeKey) {
        await collection.dropIndex(index.name);
      }
    }
    await IPDConsent.syncIndexes();
    await OTRequest.syncIndexes();
    await OTSchedule.syncIndexes();
    await OTStaff.syncIndexes();
    await OTClinicalForm.syncIndexes();
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', report }, null, 2));
  await mongoose.disconnect();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
