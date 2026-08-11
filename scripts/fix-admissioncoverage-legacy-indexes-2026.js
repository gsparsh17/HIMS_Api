#!/usr/bin/env node
'use strict';

/**
 * Repairs legacy / conflicting AdmissionCoverage indexes for unified OPD/IPD coverage.
 *
 * Safe to re-run. Supports recovery from a partially-applied v1 migration.
 *
 * Preview:
 *   node scripts/fix-admissioncoverage-legacy-indexes-2026.js
 *
 * Apply:
 *   node scripts/fix-admissioncoverage-legacy-indexes-2026.js --apply
 *
 * Index changes are collection-wide, not hospital-scoped.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

const EXPECTED_INDEXES = [
  {
    name: 'hospitalId_1_admissionId_1_active_1',
    key: { hospitalId: 1, admissionId: 1, active: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        encounterType: 'IPD',
        active: true,
        admissionId: { $exists: true }
      }
    }
  },
  {
    name: 'hospitalId_1_appointmentId_1_active_1',
    key: { hospitalId: 1, appointmentId: 1, active: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        encounterType: 'OPD',
        active: true,
        appointmentId: { $exists: true }
      }
    }
  }
];

function sameKey(actual, expected) {
  const a = Object.entries(actual || {});
  const b = Object.entries(expected || {});
  return a.length === b.length && a.every(([key, value], index) => (
    b[index]?.[0] === key && b[index]?.[1] === value
  ));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function samePartial(actual, expected) {
  return JSON.stringify(canonical(actual || {}))
    === JSON.stringify(canonical(expected || {}));
}

function isExpectedEquivalent(index, spec) {
  return Boolean(
    index
    && index.name === spec.name
    && index.unique === true
    && sameKey(index.key, spec.key)
    && samePartial(
      index.partialFilterExpression,
      spec.options.partialFilterExpression
    )
  );
}

function isLegacyUnsafeIndex(index) {
  if (!index?.unique) return false;

  return sameKey(index.key, { admissionId: 1, active: 1 })
    || sameKey(index.key, { appointmentId: 1, active: 1 });
}

function findExpectedConflicts(indexes, spec) {
  return indexes.filter((index) => {
    if (isExpectedEquivalent(index, spec)) return false;

    // MongoDB cannot create an index when an existing index has either the same
    // generated name or the same key pattern with incompatible options.
    return index.name === spec.name || sameKey(index.key, spec.key);
  });
}

function summarizeIndex(index) {
  return {
    name: index.name,
    key: index.key,
    unique: Boolean(index.unique),
    partialFilterExpression: index.partialFilterExpression || null
  };
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI (or MONGODB_URI) is required');

  await mongoose.connect(mongoUri);

  const collection = mongoose.connection.collection('admissioncoverages');
  let indexes = await collection.indexes();

  const staleLegacy = indexes.filter(isLegacyUnsafeIndex);

  const expectedConflicts = [];
  for (const spec of EXPECTED_INDEXES) {
    for (const index of findExpectedConflicts(indexes, spec)) {
      if (!expectedConflicts.some((existing) => existing.name === index.name)) {
        expectedConflicts.push(index);
      }
    }
  }

  const expectedMissing = EXPECTED_INDEXES.filter(
    (spec) => !indexes.some((index) => isExpectedEquivalent(index, spec))
  );

  const dropCandidates = [];
  for (const index of [...staleLegacy, ...expectedConflicts]) {
    if (index.name === '_id_') continue;
    if (!dropCandidates.some((existing) => existing.name === index.name)) {
      dropCandidates.push(index);
    }
  }

  const report = {
    mode: APPLY ? 'APPLY' : 'PREVIEW',
    database: mongoose.connection.name,
    collection: collection.collectionName,
    staleLegacyUniqueIndexes: staleLegacy.map(summarizeIndex),
    conflictingExpectedIndexes: expectedConflicts.map(summarizeIndex),
    expectedIndexesMissing: expectedMissing.map((spec) => ({
      name: spec.name,
      key: spec.key,
      unique: true,
      partialFilterExpression: spec.options.partialFilterExpression
    })),
    indexesToDrop: dropCandidates.map(summarizeIndex),
    writesPlanned: dropCandidates.length + expectedMissing.length,
    writesApplied: 0
  };

  if (APPLY) {
    // Drop every stale/conflicting definition first. This makes the migration
    // recover cleanly if a previous run failed halfway through.
    for (const index of dropCandidates) {
      const currentNames = new Set((await collection.indexes()).map((item) => item.name));
      if (!currentNames.has(index.name)) continue;

      await collection.dropIndex(index.name);
      report.writesApplied += 1;
    }

    // Re-read indexes after all drops, then create only missing canonical ones.
    indexes = await collection.indexes();

    for (const spec of EXPECTED_INDEXES) {
      if (indexes.some((index) => isExpectedEquivalent(index, spec))) continue;

      // Defensive recovery: if an incompatible same-name/same-key index still
      // exists (e.g. created concurrently), drop it before creating canonical.
      const conflicts = findExpectedConflicts(indexes, spec);
      for (const conflict of conflicts) {
        await collection.dropIndex(conflict.name);
        report.writesApplied += 1;
      }

      await collection.createIndex(spec.key, {
        ...spec.options,
        name: spec.name
      });
      report.writesApplied += 1;
      indexes = await collection.indexes();
    }

    const finalRelevantIndexes = indexes
      .filter((index) => {
        const fields = Object.keys(index.key || {});
        return fields.includes('admissionId') || fields.includes('appointmentId');
      })
      .map(summarizeIndex);

    report.finalRelevantIndexes = finalRelevantIndexes;

    const finalProblems = [];

    for (const index of indexes.filter(isLegacyUnsafeIndex)) {
      finalProblems.push(`Legacy unsafe unique index remains: ${index.name}`);
    }

    for (const spec of EXPECTED_INDEXES) {
      if (!indexes.some((index) => isExpectedEquivalent(index, spec))) {
        finalProblems.push(`Canonical expected index missing: ${spec.name}`);
      }
    }

    report.validation = {
      ok: finalProblems.length === 0,
      problems: finalProblems
    };

    if (finalProblems.length) {
      throw new Error(`AdmissionCoverage index validation failed: ${finalProblems.join('; ')}`);
    }
  }

  console.log(JSON.stringify(report, null, 2));

  if (!APPLY && report.writesPlanned > 0) {
    console.log('\nPREVIEW ONLY: re-run with --apply after reviewing the report.');
  } else if (!APPLY) {
    console.log('\nNo index changes are required.');
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}

module.exports = {
  sameKey,
  canonical,
  samePartial,
  isLegacyUnsafeIndex,
  isExpectedEquivalent,
  findExpectedConflicts,
  EXPECTED_INDEXES
};
