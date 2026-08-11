#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const specs = [
  {
    name: 'uniq_emergency_frontdesk_appointment',
    key: { hospitalId: 1, appointmentId: 1 },
    options: { unique: true, partialFilterExpression: { appointmentId: { $type: 'objectId' } } }
  },
  {
    name: 'uniq_emergency_frontdesk_admission',
    key: { hospitalId: 1, admissionId: 1 },
    options: { unique: true, partialFilterExpression: { admissionId: { $type: 'objectId' } } }
  }
];

const canonical = (value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).sort().reduce((out, key) => ({ ...out, [key]: canonical(value[key]) }), {})
  : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI (or MONGODB_URI) is required');
  await mongoose.connect(uri);
  const collection = mongoose.connection.collection('emergencyencounters');
  let indexes = await collection.indexes();
  const missing = specs.filter((spec) => !indexes.some((index) =>
    index.name === spec.name && index.unique === true && same(index.key, spec.key) && same(index.partialFilterExpression, spec.options.partialFilterExpression)
  ));
  const conflicts = indexes.filter((index) => missing.some((spec) => index.name === spec.name));
  const report = {
    mode: APPLY ? 'APPLY' : 'PREVIEW',
    database: mongoose.connection.name,
    collection: collection.collectionName,
    indexesToReplace: conflicts.map(({ name, key, unique, partialFilterExpression }) => ({ name, key, unique: Boolean(unique), partialFilterExpression: partialFilterExpression || null })),
    indexesToCreate: missing.map((spec) => ({ name: spec.name, key: spec.key, ...spec.options })),
    writesPlanned: conflicts.length + missing.length,
    writesApplied: 0
  };
  if (APPLY) {
    for (const conflict of conflicts) {
      await collection.dropIndex(conflict.name);
      report.writesApplied += 1;
    }
    indexes = await collection.indexes();
    for (const spec of specs) {
      const exists = indexes.some((index) => index.name === spec.name && index.unique === true && same(index.key, spec.key) && same(index.partialFilterExpression, spec.options.partialFilterExpression));
      if (!exists) {
        await collection.createIndex(spec.key, { ...spec.options, name: spec.name });
        report.writesApplied += 1;
        indexes = await collection.indexes();
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!APPLY && report.writesPlanned) console.log('\nPREVIEW ONLY: re-run with --apply after reviewing the report.');
  if (!APPLY && !report.writesPlanned) console.log('\nNo emergency front-desk index changes are required.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => mongoose.connection.close().catch(() => {}));
