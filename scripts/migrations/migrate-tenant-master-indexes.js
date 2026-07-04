/**
 * Converts global master natural-key indexes into tenant-aware indexes.
 * Run only after duplicate codes/employees have been reconciled in staging.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LabTest = require('../../models/LabTest');
const ImagingTest = require('../../models/ImagingTest');
const HRStaffProfile = require('../../models/HRStaffProfile');

async function dropIfPresent(collection, indexName) {
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === indexName)) {
    await collection.dropIndex(indexName);
    console.log(`Dropped ${collection.collection.name}.${indexName}`);
  }
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  await dropIfPresent(LabTest.collection, 'code_1');
  await dropIfPresent(ImagingTest.collection, 'code_1');
  await dropIfPresent(HRStaffProfile.collection, 'employee_code_1');
  await Promise.all([LabTest.syncIndexes(), ImagingTest.syncIndexes(), HRStaffProfile.syncIndexes()]);
  console.log('Tenant master indexes synchronized.');
}
run().then(() => mongoose.disconnect()).catch((error) => { console.error(error); mongoose.disconnect().finally(() => process.exit(1)); });
