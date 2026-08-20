#!/usr/bin/env node
'use strict';

/**
 * OPD/IPD billing-integrity migration.
 *
 * Safe default is preview. Use --apply to:
 *  - migrate retired RateCardItem.wardRates into rates.exactWard;
 *  - replace the old rateCardId+externalCode unique index with the
 *    clinician-context-aware unique index required for New/Follow-up/IPD ward tariffs.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');

const exactWardKey = {
  general: 'general',
  semi_private: 'semiPrivate',
  semiPrivate: 'semiPrivate',
  private: 'private',
  icu: 'icu',
  day_care: 'dayCare',
  dayCare: 'dayCare',
  not_applicable: 'notApplicable',
  notApplicable: 'notApplicable'
};

function canonicalWardRates(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const target = exactWardKey[key];
    if (!target || value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[target] = n;
  }
  return out;
}

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const collection = db.collection('ratecarditems');

  const legacyRows = await collection.find({ wardRates: { $exists: true, $type: 'object' } })
    .project({ _id: 1, wardRates: 1, rates: 1, pricingMode: 1 }).toArray();
  const wardPlan = legacyRows.map((row) => ({
    id: String(row._id),
    exactWard: { ...canonicalWardRates(row.wardRates), ...canonicalWardRates(row.rates?.exactWard) },
    pricingMode: Object.keys({ ...canonicalWardRates(row.wardRates), ...canonicalWardRates(row.rates?.exactWard) }).length
      ? 'exact_ward' : row.pricingMode
  }));

  const indexes = await collection.indexes();
  const oldIndexes = indexes.filter((idx) => {
    const keys = Object.keys(idx.key || {});
    return idx.unique && keys.length === 2 && idx.key.rateCardId === 1 && idx.key.externalCode === 1;
  });
  const targetName = 'rateCard_external_clinician_context_unique';
  const targetExists = indexes.some((idx) => idx.name === targetName);

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'preview',
    legacyWardRows: wardPlan.length,
    oldIndexes: oldIndexes.map((idx) => idx.name),
    targetIndexExists: targetExists
  }, null, 2));

  if (!APPLY) {
    console.log('\nPREVIEW ONLY: rerun with --apply after backup/review.');
    return;
  }

  for (const row of wardPlan) {
    await collection.updateOne(
      { _id: new mongoose.Types.ObjectId(row.id) },
      {
        $set: { 'rates.exactWard': row.exactWard, ...(row.pricingMode ? { pricingMode: row.pricingMode } : {}) },
        $unset: { wardRates: '' }
      }
    );
  }

  for (const idx of oldIndexes) await collection.dropIndex(idx.name);
  if (!targetExists) {
    await collection.createIndex({
      rateCardId: 1,
      externalCode: 1,
      'clinicianContext.doctorId': 1,
      'clinicianContext.encounterType': 1,
      'clinicianContext.visitType': 1,
      'clinicianContext.wardEntitlement': 1
    }, { unique: true, name: targetName });
  }

  console.log(`Applied: ${wardPlan.length} ward-rate row(s) migrated; clinician-context index ready.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => mongoose.disconnect().catch(() => undefined));
