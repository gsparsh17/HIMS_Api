#!/usr/bin/env node

/*
 * Roll back only values and records explicitly captured by
 * migrate-hims-2026.js.
 *
 * Usage:
 *   node scripts/rollback-hims-2026.js \
 *     --state=migration-state/hims-2026-applied.json
 *
 *   node scripts/rollback-hims-2026.js \
 *     --state=migration-state/hims-2026-applied.json \
 *     --apply
 *
 * Add --force only when a migrated field was intentionally changed after the
 * migration and you still want to overwrite that later value.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const stateArg = process.argv.find((value) =>
  value.startsWith('--state=')
);

if (!stateArg) {
  console.error(
    'Usage: node scripts/rollback-hims-2026.js '
    + '--state=<migration-state.json> [--apply] [--force]'
  );
  process.exit(2);
}

const STATE_PATH = path.resolve(
  stateArg.split('=').slice(1).join('=')
);
const state = JSON.parse(
  fs.readFileSync(STATE_PATH, 'utf8')
);

if (state.version !== 'HIMS-2026-07') {
  throw new Error(
    `Unsupported migration state version: ${state.version}`
  );
}

if (state.applied !== true) {
  throw new Error(
    'Rollback requires the state file produced by an applied migration. '
    + 'A dry-run state file cannot be rolled back.'
  );
}

const modelNames = [
  'Hospital',
  'User',
  'HRStaffProfile',
  'Patient',
  'Doctor',
  'Department',
  'Ward',
  'Room',
  'Bed',
  'LabTest',
  'ImagingTest',
  'PathologyStaff',
  'RadiologyStaff',
  'LabRequest',
  'RadiologyRequest',
  'IPDAdmission',
  'OfflineSyncLog',
  'DischargeSummary',
  'Payer',
  'AdmissionCoverage',
  'IPDAccommodationSegment'
];

for (const name of modelNames) {
  try {
    require(`../models/${name}`);
  } catch {
    // The state file determines which registered models are required.
  }
}

function Model(name) {
  const model = mongoose.models[name];

  if (!model) {
    throw new Error(`Unknown model ${name}`);
  }

  return model;
}

function getPathValue(source, dottedPath) {
  return dottedPath
    .split('.')
    .reduce(
      (current, part) =>
        current === null || current === undefined
          ? undefined
          : current[part],
      source
    );
}

function same(left, right) {
  if (left === right) {
    return true;
  }

  if (left === null || left === undefined) {
    return false;
  }

  if (right === null || right === undefined) {
    return false;
  }

  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }

  return String(left) === String(right);
}

async function main() {
  const mongoUri =
    process.env.MONGODB_URI
    || process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error(
      'MONGODB_URI or MONGO_URI is required'
    );
  }

  await mongoose.connect(
    mongoUri,
    {
      autoIndex: false,
      autoCreate: false
    }
  );

  console.log(
    `[HIMS 2026 rollback] ${APPLY ? 'APPLY' : 'DRY RUN'} `
    + `using ${STATE_PATH}`
  );

  const result = {
    removed: {},
    restored: {},
    skipped: []
  };

  for (const item of [
    ...(state.created || [])
  ].reverse()) {
    const model = Model(item.model);
    const exists = await model.exists({
      _id: item.id
    });

    if (!exists) {
      continue;
    }

    result.removed[item.model] =
      (result.removed[item.model] || 0) + 1;

    if (APPLY) {
      await model.deleteOne({
        _id: item.id
      });
    }
  }

  for (const item of [
    ...(state.updated || [])
  ].reverse()) {
    const model = Model(item.model);
    const current = await model.findById(
      item.id
    ).lean();

    if (!current) {
      result.skipped.push({
        model: item.model,
        id: item.id,
        reason: 'Document no longer exists'
      });
      continue;
    }

    if (!FORCE) {
      const changedAfterMigration = Object.entries(
        item.after || {}
      ).some(([key, expected]) =>
        !same(
          getPathValue(current, key),
          expected
        )
      );

      if (changedAfterMigration) {
        result.skipped.push({
          model: item.model,
          id: item.id,
          reason:
            'One or more migrated fields changed after migration'
        });
        continue;
      }
    }

    const setValues = {};
    const unsetValues = {};

    for (const [key, value] of Object.entries(
      item.before || {}
    )) {
      const existedBefore =
        item.beforeExists?.[key];

      if (existedBefore === false) {
        unsetValues[key] = 1;
      } else if (
        existedBefore === undefined
        && (value === null || value === undefined)
      ) {
        unsetValues[key] = 1;
      } else {
        setValues[key] = value;
      }
    }

    result.restored[item.model] =
      (result.restored[item.model] || 0) + 1;

    if (APPLY) {
      const update = {};

      if (Object.keys(setValues).length) {
        update.$set = setValues;
      }

      if (Object.keys(unsetValues).length) {
        update.$unset = unsetValues;
      }

      if (Object.keys(update).length) {
        await model.updateOne(
          {
            _id: item.id
          },
          update
        );
      }
    }
  }

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  if (!APPLY) {
    console.log(
      'No database writes were performed. '
      + 'Re-run with --apply after review.'
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
