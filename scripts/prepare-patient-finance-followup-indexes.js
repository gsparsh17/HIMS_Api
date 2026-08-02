#!/usr/bin/env node
'use strict';

/**
 * Adds the indexes used by patient-wide OPD billing and idempotent charge creation.
 *
 * Preview (default): node scripts/prepare-patient-finance-followup-indexes.js
 * Apply:             node scripts/prepare-patient-finance-followup-indexes.js --apply
 *
 * This script treats an existing index with the same key pattern and compatible
 * options as already present, even when MongoDB generated a different name.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');

const APPLY = process.argv.includes('--apply');

const desiredIndexes = [
  {
    model: Bill,
    name: 'idempotency_key_1',
    key: { idempotency_key: 1 },
    options: { name: 'idempotency_key_1', unique: true, sparse: true }
  },
  {
    model: Bill,
    name: 'bill_patient_scope_generated',
    key: { hospital_id: 1, patient_id: 1, admission_id: 1, generated_at: -1 },
    options: { name: 'bill_patient_scope_generated' }
  },
  {
    model: Invoice,
    name: 'invoice_patient_scope_issued',
    key: { hospital_id: 1, patient_id: 1, admission_id: 1, issue_date: -1 },
    options: { name: 'invoice_patient_scope_issued' }
  },
  {
    model: Invoice,
    name: 'invoice_bill_ids_lookup',
    key: { bill_ids: 1 },
    options: { name: 'invoice_bill_ids_lookup' }
  },
  {
    model: FinancialTransaction,
    name: 'financial_transaction_patient_scope',
    key: { hospitalId: 1, patientId: 1, admissionId: 1, createdAt: 1 },
    options: { name: 'financial_transaction_patient_scope' }
  },
  {
    model: PatientAdvanceLedger,
    name: 'patient_advance_opd_wallet',
    key: { hospitalId: 1, patientId: 1, walletType: 1, createdAt: -1 },
    options: { name: 'patient_advance_opd_wallet' }
  }
];

function orderedEntries(value) {
  return Object.entries(value || {});
}

function sameKeyPattern(left, right) {
  const a = orderedEntries(left);
  const b = orderedEntries(right);
  if (a.length !== b.length) return false;
  return a.every(([field, direction], index) => {
    const [otherField, otherDirection] = b[index] || [];
    return field === otherField && direction === otherDirection;
  });
}

function normalizeBoolean(value) {
  return value === true;
}

function relevantOptions(indexOrOptions) {
  return {
    unique: normalizeBoolean(indexOrOptions?.unique),
    sparse: normalizeBoolean(indexOrOptions?.sparse),
    expireAfterSeconds: indexOrOptions?.expireAfterSeconds,
    partialFilterExpression: indexOrOptions?.partialFilterExpression,
    collation: indexOrOptions?.collation
  };
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function compatibleOptions(existing, desired) {
  const actual = relevantOptions(existing);
  const wanted = relevantOptions(desired);
  return (
    actual.unique === wanted.unique &&
    actual.sparse === wanted.sparse &&
    actual.expireAfterSeconds === wanted.expireAfterSeconds &&
    sameJson(actual.partialFilterExpression, wanted.partialFilterExpression) &&
    sameJson(actual.collation, wanted.collation)
  );
}

async function duplicateIdempotencyKeys() {
  return Bill.aggregate([
    { $match: { idempotency_key: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$idempotency_key', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 25 }
  ]);
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI is required');
  await mongoose.connect(mongoUri);

  const duplicates = await duplicateIdempotencyKeys();
  if (duplicates.length) {
    throw new Error(
      `Duplicate Bill idempotency keys must be resolved before applying indexes: ${JSON.stringify(duplicates)}`
    );
  }

  const result = [];

  for (const definition of desiredIndexes) {
    const existingIndexes = await definition.model.collection.indexes();
    const sameName = existingIndexes.find((index) => index.name === definition.name);

    if (sameName) {
      if (!sameKeyPattern(sameName.key, definition.key)) {
        throw new Error(
          `Index name conflict on ${definition.model.collection.collectionName}.${definition.name}: ` +
          `existing key ${JSON.stringify(sameName.key)} differs from desired key ${JSON.stringify(definition.key)}`
        );
      }
      if (!compatibleOptions(sameName, definition.options)) {
        throw new Error(
          `Index option conflict on ${definition.model.collection.collectionName}.${definition.name}: ` +
          `existing options ${JSON.stringify(relevantOptions(sameName))} differ from desired options ` +
          `${JSON.stringify(relevantOptions(definition.options))}`
        );
      }
      result.push({
        collection: definition.model.collection.collectionName,
        index: definition.name,
        status: 'already-present'
      });
      continue;
    }

    const sameKey = existingIndexes.find((index) => sameKeyPattern(index.key, definition.key));
    if (sameKey) {
      if (!compatibleOptions(sameKey, definition.options)) {
        throw new Error(
          `Equivalent-key index option conflict on ${definition.model.collection.collectionName}: ` +
          `existing index ${sameKey.name} uses key ${JSON.stringify(sameKey.key)} with options ` +
          `${JSON.stringify(relevantOptions(sameKey))}; desired index ${definition.name} requires options ` +
          `${JSON.stringify(relevantOptions(definition.options))}. No index was dropped automatically.`
        );
      }
      result.push({
        collection: definition.model.collection.collectionName,
        index: definition.name,
        existingIndex: sameKey.name,
        status: 'already-present-equivalent'
      });
      continue;
    }

    if (!APPLY) {
      result.push({
        collection: definition.model.collection.collectionName,
        index: definition.name,
        status: 'would-create',
        key: definition.key
      });
      continue;
    }

    const name = await definition.model.collection.createIndex(definition.key, definition.options);
    result.push({
      collection: definition.model.collection.collectionName,
      index: name,
      status: 'created'
    });
  }

  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'PREVIEW', result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
