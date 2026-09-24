#!/usr/bin/env node
'use strict';

/**
 * Canonical index/bootstrap preparation for a NEW hospital MongoDB database.
 *
 * Goals:
 *   1. Load every Mongoose model in /models.
 *   2. Create every index declared by every current model schema, including
 *      field-level `index: true` declarations and compound/partial/TTL indexes.
 *   3. Ensure a small registry of important supplemental indexes that exist for
 *      production query paths but are not all represented as schema indexes.
 *   4. Verify the resulting index state and fail loudly on incompatible index
 *      definitions instead of dropping/replacing indexes automatically.
 *
 * This command is intended for a fresh/new hospital database. It is safe to
 * re-run when the existing indexes are compatible. It is NOT a replacement for
 * migrations that repair legacy data or incompatible indexes in older DBs.
 *
 * Usage:
 *   npm run db:prepare-new-hospital
 *   npm run db:prepare-new-hospital -- --expected-db-name=hospital_xyz
 *   npm run db:prepare-new-hospital -- --verify-only
 *
 * Safety:
 *   Database names `admin`, `config`, `local`, and `test` are refused by
 *   default. Use --allow-unsafe-db-name only for an intentional dev/test run.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const UNSAFE_DATABASE_NAMES = new Set(['admin', 'config', 'local', 'test']);
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function valueArg(name) {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const VERIFY_ONLY = hasFlag('--verify-only');
const ALLOW_UNSAFE_DB_NAME = hasFlag('--allow-unsafe-db-name');
const EXPECTED_DB_NAME = valueArg('--expected-db-name') || process.env.EXPECTED_DB_NAME || '';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = canonical(value[key]);
        return out;
      }, {});
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
}

function sameKeyPattern(left, right) {
  const a = Object.entries(left || {});
  const b = Object.entries(right || {});
  if (a.length !== b.length) return false;
  return a.every(([field, direction], index) => {
    const [otherField, otherDirection] = b[index] || [];
    return field === otherField && direction === otherDirection;
  });
}

function desiredOptionMatches(existing, desired = {}) {
  // Only compare options that materially affect index semantics and that the
  // desired definition actually specifies. MongoDB may add other metadata.
  if (desired.unique !== undefined && Boolean(existing.unique) !== Boolean(desired.unique)) return false;
  if (desired.sparse !== undefined && Boolean(existing.sparse) !== Boolean(desired.sparse)) return false;
  if (desired.expireAfterSeconds !== undefined && existing.expireAfterSeconds !== desired.expireAfterSeconds) return false;
  if (desired.partialFilterExpression !== undefined && !sameJson(existing.partialFilterExpression, desired.partialFilterExpression)) return false;
  if (desired.collation !== undefined && !sameJson(existing.collation, desired.collation)) return false;
  return true;
}

function walkJsFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function loadEveryModel() {
  const modelsRoot = path.resolve(__dirname, '..', 'models');
  const files = walkJsFiles(modelsRoot)
    .filter((file) => path.basename(file) !== 'index.js')
    .sort();

  const failures = [];
  for (const file of files) {
    try {
      require(file);
    } catch (error) {
      failures.push({
        file: path.relative(path.resolve(__dirname, '..'), file),
        message: error?.stack || error?.message || String(error)
      });
    }
  }

  if (failures.length) {
    const details = failures
      .map((failure) => `\n--- ${failure.file} ---\n${failure.message}`)
      .join('\n');
    throw new Error(`Failed to load ${failures.length} model file(s). No index preparation was attempted.${details}`);
  }

  return files;
}

// These are query-path indexes that historically had dedicated preparation
// scripts or migration-time createIndex calls. Most critical indexes now live
// in the model schemas; this registry additionally protects the few useful
// production indexes that are not currently declared there and verifies the
// semantics of the most failure-prone unique/partial indexes.
const SUPPLEMENTAL_INDEXES = [
  // Canonical Doctor identifier uniqueness. Keep this here even though the
  // Doctor schema declares the same index: it acts as a provisioning-time
  // regression guard against accidentally deploying an older schema that used
  // a sparse unique compound index and allowed doctorId=null conflicts.
  {
    model: 'Doctor',
    key: { hospitalId: 1, doctorId: 1 },
    options: {
      name: 'hospitalId_1_doctorId_1',
      unique: true,
      partialFilterExpression: {
        doctorId: { $type: 'string', $gt: '' }
      }
    }
  },

  // Patient-wide billing / finance follow-up indexes.
  {
    model: 'Bill',
    key: { idempotency_key: 1 },
    options: { name: 'idempotency_key_1', unique: true, sparse: true }
  },
  {
    model: 'Bill',
    key: { hospital_id: 1, patient_id: 1, admission_id: 1, generated_at: -1 },
    options: { name: 'bill_patient_scope_generated' }
  },
  {
    model: 'Invoice',
    key: { hospital_id: 1, patient_id: 1, admission_id: 1, issue_date: -1 },
    options: { name: 'invoice_patient_scope_issued' }
  },
  {
    model: 'Invoice',
    key: { bill_ids: 1 },
    options: { name: 'invoice_bill_ids_lookup' }
  },
  {
    model: 'FinancialTransaction',
    key: { hospitalId: 1, patientId: 1, admissionId: 1, createdAt: 1 },
    options: { name: 'financial_transaction_patient_scope' }
  },
  {
    model: 'PatientAdvanceLedger',
    key: { hospitalId: 1, patientId: 1, walletType: 1, createdAt: -1 },
    options: { name: 'patient_advance_opd_wallet' }
  },

  // High-traffic front-desk worklist indexes from the latency patch.
  {
    model: 'Appointment',
    key: { hospital_id: 1, patient_id: 1, appointment_date: -1, start_time: -1, created_at: -1 },
    options: {}
  },
  {
    model: 'Appointment',
    key: { hospital_id: 1, patient_id: 1, status: 1, appointment_date: -1, start_time: -1 },
    options: {}
  },
  {
    model: 'Appointment',
    key: { hospital_id: 1, patient_id: 1, status: 1 },
    options: {}
  },
  {
    model: 'IPDAdmission',
    key: { hospitalId: 1, patientId: 1, admissionDate: -1, createdAt: -1 },
    options: {}
  },
  {
    model: 'IPDAdmission',
    key: { hospitalId: 1, patientId: 1, status: 1, admissionDate: -1 },
    options: {}
  },
  {
    model: 'Patient',
    key: { hospitalId: 1, registered_at: -1, _id: -1 },
    options: {}
  },

  // Checkout idempotency must exclude missing/null keys.
  ...['LabRequest', 'RadiologyRequest', 'ProcedureRequest'].map((model) => ({
    model,
    key: { hospitalId: 1, deskCheckoutKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: { deskCheckoutKey: { $type: 'string' } }
    }
  })),

  // Pharmacy sale idempotency must also exclude missing/null keys.
  {
    model: 'Sale',
    key: { hospitalId: 1, idempotencyKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        hospitalId: { $type: 'objectId' },
        idempotencyKey: { $type: 'string' }
      }
    }
  },

  // Emergency front-desk links are unique only when the link exists.
  {
    model: 'EmergencyEncounter',
    key: { hospitalId: 1, appointmentId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { appointmentId: { $type: 'objectId' } }
    }
  },
  {
    model: 'EmergencyEncounter',
    key: { hospitalId: 1, admissionId: 1 },
    options: {
      unique: true,
      partialFilterExpression: { admissionId: { $type: 'objectId' } }
    }
  },

  // Unified OPD/IPD coverage active-record uniqueness.
  {
    model: 'AdmissionCoverage',
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
    model: 'AdmissionCoverage',
    key: { hospitalId: 1, appointmentId: 1, active: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        encounterType: 'OPD',
        active: true,
        appointmentId: { $exists: true }
      }
    }
  },

  // Tenant-scoped master/service uniqueness used by insurance/tariff flows.
  { model: 'Procedure', key: { hospitalId: 1, code: 1 }, options: { unique: true } },
  { model: 'LabTest', key: { hospitalId: 1, code: 1 }, options: { unique: true } },
  { model: 'ImagingTest', key: { hospitalId: 1, code: 1 }, options: { unique: true } },
  { model: 'CoverageUtilization', key: { hospitalId: 1, sourceKey: 1 }, options: { unique: true } },
  { model: 'CoverageUtilization', key: { hospitalId: 1, coverageId: 1, status: 1, createdAt: 1 }, options: {} },

  // Current consent and tariff uniqueness definitions.
  {
    model: 'IPDConsent',
    key: { hospitalId: 1, admissionId: 1, templateId: 1, scopeKey: 1 },
    options: { unique: true }
  },
  {
    model: 'RateCardItem',
    key: {
      rateCardId: 1,
      externalCode: 1,
      'clinicianContext.doctorId': 1,
      'clinicianContext.encounterType': 1,
      'clinicianContext.visitType': 1,
      'clinicianContext.wardEntitlement': 1
    },
    options: { unique: true }
  }
];

async function ensureSupplementalIndex(spec) {
  const model = mongoose.models[spec.model];
  if (!model) throw new Error(`Supplemental index references unregistered model: ${spec.model}`);

  let indexes;
  try {
    indexes = await model.collection.indexes();
  } catch (error) {
    // In --verify-only mode a brand-new database may not have created the
    // collection yet. Report the supplemental index as missing instead of
    // aborting with NamespaceNotFound. During CREATE + VERIFY, treat the
    // missing namespace as an empty index set and create the requested index.
    if (error?.code === 26 || /NamespaceNotFound/i.test(error?.message || '')) {
      if (VERIFY_ONLY) {
        return {
          model: spec.model,
          collection: model.collection.collectionName,
          index: spec.options?.name || JSON.stringify(spec.key),
          status: 'missing'
        };
      }
      indexes = [];
    } else {
      throw error;
    }
  }

  const equivalent = indexes.find((index) => (
    sameKeyPattern(index.key, spec.key)
    && desiredOptionMatches(index, spec.options)
  ));

  if (equivalent) {
    return {
      model: spec.model,
      collection: model.collection.collectionName,
      index: equivalent.name,
      status: 'present'
    };
  }

  const sameName = spec.options?.name
    ? indexes.find((index) => index.name === spec.options.name)
    : null;
  const sameKey = indexes.find((index) => sameKeyPattern(index.key, spec.key));

  if (sameName || sameKey) {
    const conflict = sameName || sameKey;
    throw new Error(
      `Incompatible index on ${model.collection.collectionName}. `
      + `Existing ${conflict.name} key=${JSON.stringify(conflict.key)} `
      + `options=${JSON.stringify({
        unique: Boolean(conflict.unique),
        sparse: Boolean(conflict.sparse),
        partialFilterExpression: conflict.partialFilterExpression || null,
        expireAfterSeconds: conflict.expireAfterSeconds
      })}; desired key=${JSON.stringify(spec.key)} options=${JSON.stringify(spec.options)}. `
      + 'This new-hospital script never drops/replaces existing indexes. Use the appropriate migration for an older database.'
    );
  }

  if (VERIFY_ONLY) {
    return {
      model: spec.model,
      collection: model.collection.collectionName,
      index: spec.options?.name || JSON.stringify(spec.key),
      status: 'missing'
    };
  }

  const created = await model.collection.createIndex(spec.key, spec.options || {});
  return {
    model: spec.model,
    collection: model.collection.collectionName,
    index: created,
    status: 'created'
  };
}

async function verifySchemaIndexes(model) {
  const desired = model.schema.indexes();
  if (!desired.length) return { declared: 0, missing: [] };

  let actual;
  try {
    actual = await model.collection.indexes();
  } catch (error) {
    // NamespaceNotFound can occur in --verify-only mode for a model whose
    // collection has never existed. Treat all declared indexes as missing.
    if (error?.code === 26 || /NamespaceNotFound/i.test(error?.message || '')) {
      return {
        declared: desired.length,
        missing: desired.map(([key, options]) => ({ key, options }))
      };
    }
    throw error;
  }

  const missing = [];
  for (const [key, options] of desired) {
    const found = actual.some((index) => (
      sameKeyPattern(index.key, key)
      && desiredOptionMatches(index, options || {})
    ));
    if (!found) missing.push({ key, options });
  }

  return { declared: desired.length, missing };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI (or MONGODB_URI) is required');

  // Explicit provisioning owns index creation. Avoid accidental auto-index
  // side effects while loading every model.
  mongoose.set('autoIndex', false);

  const modelFiles = loadEveryModel();
  const modelNames = mongoose.modelNames().sort();

  if (!modelNames.length) throw new Error('No Mongoose models were registered from /models');

  await mongoose.connect(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 15000
  });

  const database = mongoose.connection.name;
  if (!database) throw new Error('MongoDB connected without a resolved database name');

  if (EXPECTED_DB_NAME && database !== EXPECTED_DB_NAME) {
    throw new Error(`Connected database is "${database}" but expected "${EXPECTED_DB_NAME}". Aborting before index creation.`);
  }

  if (UNSAFE_DATABASE_NAMES.has(database.toLowerCase()) && !ALLOW_UNSAFE_DB_NAME) {
    throw new Error(
      `Refusing to prepare database "${database}" because it is a protected/dev database name. `
      + 'Use a hospital-specific database in MONGO_URI. For an intentional dev run only, append --allow-unsafe-db-name.'
    );
  }

  const collectionNames = new Set(modelNames.map((name) => mongoose.models[name].collection.collectionName));
  const declaredIndexCount = modelNames.reduce(
    (total, name) => total + mongoose.models[name].schema.indexes().length,
    0
  );

  console.log('='.repeat(72));
  console.log('MEDIQLIQ NEW HOSPITAL DATABASE INDEX PREPARATION');
  console.log('='.repeat(72));
  console.log(`Mode               : ${VERIFY_ONLY ? 'VERIFY ONLY' : 'CREATE + VERIFY'}`);
  console.log(`Database           : ${database}`);
  console.log(`Model files loaded : ${modelFiles.length}`);
  console.log(`Models registered  : ${modelNames.length}`);
  console.log(`Collections        : ${collectionNames.size}`);
  console.log(`Schema indexes     : ${declaredIndexCount}`);
  console.log(`Supplemental checks: ${SUPPLEMENTAL_INDEXES.length}`);
  console.log('-'.repeat(72));

  const creationFailures = [];
  let modelsIndexed = 0;

  if (!VERIFY_ONLY) {
    for (const name of modelNames) {
      const model = mongoose.models[name];
      const declared = model.schema.indexes().length;
      if (!declared) continue;
      try {
        await model.createIndexes();
        modelsIndexed += 1;
        console.log(`OK schema ${name} (${model.collection.collectionName}) - ${declared} declared index(es)`);
      } catch (error) {
        creationFailures.push({
          model: name,
          collection: model.collection.collectionName,
          error: error?.message || String(error)
        });
        console.error(`FAIL schema ${name} (${model.collection.collectionName}) - ${error?.message || error}`);
      }
    }
  }

  if (creationFailures.length) {
    throw new Error(
      `Schema index creation failed for ${creationFailures.length} model(s). `
      + `No indexes were dropped automatically. Details: ${JSON.stringify(creationFailures, null, 2)}`
    );
  }

  const supplementalResults = [];
  for (const spec of SUPPLEMENTAL_INDEXES) {
    const result = await ensureSupplementalIndex(spec);
    supplementalResults.push(result);
    const tag = result.status === 'missing' ? 'MISSING' : 'OK';
    console.log(`${tag} supplemental ${result.collection}.${result.index} (${result.status})`);
  }

  console.log('-'.repeat(72));
  console.log('Verifying every schema-declared index...');

  const missingSchemaIndexes = [];
  let verifiedSchemaIndexCount = 0;
  for (const name of modelNames) {
    const model = mongoose.models[name];
    const result = await verifySchemaIndexes(model);
    verifiedSchemaIndexCount += result.declared - result.missing.length;
    if (result.missing.length) {
      missingSchemaIndexes.push({
        model: name,
        collection: model.collection.collectionName,
        missing: result.missing
      });
    }
  }

  const missingSupplemental = supplementalResults.filter((item) => item.status === 'missing');

  const finalReport = {
    success: missingSchemaIndexes.length === 0 && missingSupplemental.length === 0,
    mode: VERIFY_ONLY ? 'VERIFY_ONLY' : 'CREATE_AND_VERIFY',
    database,
    modelFilesLoaded: modelFiles.length,
    modelsRegistered: modelNames.length,
    collections: collectionNames.size,
    schemaIndexesDeclared: declaredIndexCount,
    schemaIndexesVerified: verifiedSchemaIndexCount,
    modelsWithSchemaIndexesCreated: modelsIndexed,
    supplementalIndexesChecked: supplementalResults.length,
    supplementalIndexesCreated: supplementalResults.filter((item) => item.status === 'created').length,
    missingSchemaIndexes,
    missingSupplementalIndexes: missingSupplemental
  };

  console.log('='.repeat(72));
  console.log(JSON.stringify(finalReport, null, 2));
  console.log('='.repeat(72));

  if (!finalReport.success) {
    throw new Error(
      `Database index verification failed: ${missingSchemaIndexes.length} model(s) have missing schema indexes and `
      + `${missingSupplemental.length} supplemental index(es) are missing.`
    );
  }

  console.log(`DATABASE READY: all current HIMS indexes are prepared on "${database}".`);
  console.log('For an OLD/legacy hospital DB, run the relevant migrations instead of relying on this fresh-DB command to replace incompatible indexes.');
}

main()
  .catch((error) => {
    console.error('\nINDEX PREPARATION FAILED');
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
