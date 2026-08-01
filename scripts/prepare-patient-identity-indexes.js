#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const Hospital = require('../models/Hospital');
const PatientIdentityAsset = require('../models/PatientIdentityAsset');
const DocumentSignature = require('../models/DocumentSignature');

const argv = process.argv.slice(2);
const valueArg = (name) => {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const apply = argv.includes('--apply');
const hospitalId = valueArg('--hospital-id');

async function main() {
  if (!hospitalId || !mongoose.isValidObjectId(hospitalId)) {
    throw new Error('Pass a valid --hospital-id=<ObjectId>');
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const hospital = await Hospital.findById(hospitalId).select('hospitalName name hospitalID registryNo').lean();
  if (!hospital) throw new Error('Hospital not found');

  const requested = [
    { model: 'PatientIdentityAsset', indexes: PatientIdentityAsset.schema.indexes() },
    { model: 'DocumentSignature', indexes: DocumentSignature.schema.indexes() }
  ];
  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'PREVIEW', hospital, requested }, null, 2));
  if (!apply) {
    console.log('Preview only. Re-run with --apply to create any missing indexes. Existing indexes are not dropped.');
    return;
  }
  await PatientIdentityAsset.createIndexes();
  await DocumentSignature.createIndexes();
  const [patientAssetIndexes, documentSignatureIndexes] = await Promise.all([
    PatientIdentityAsset.collection.indexes(),
    DocumentSignature.collection.indexes()
  ]);
  console.log(JSON.stringify({
    success: true,
    patientIdentityAssetIndexes: patientAssetIndexes.map((item) => item.name),
    documentSignatureIndexes: documentSignatureIndexes.map((item) => item.name)
  }, null, 2));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await mongoose.connection.close().catch(() => {}); });
