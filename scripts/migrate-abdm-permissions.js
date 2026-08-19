#!/usr/bin/env node
'use strict';

/**
 * One-time MediQliq HIMS migration:
 * Adds explicit ABDM permission to legacy users whose roles already used ABDM
 * before `abdm` became a main module permission.
 *
 * SAFE BEHAVIOR
 * - Dry-run by default.
 * - Nothing is changed unless --apply is supplied.
 * - Requires --hospital-id=<ObjectId> OR --all-hospitals.
 * - Only targets:
 *      doctor
 *      nurse
 *      staff
 *      registrar
 *      receptionist
 *
 * - Does NOT touch admins / restricted admins.
 * - Does NOT touch pharmacy, HR, finance, pathology, radiology,
 *   OT, store, equipment, insurance, demo, etc.
 * - Does NOT overwrite an existing abdm permission.
 *   So an intentional `abdm: none` remains untouched.
 * - Does NOT modify sidebarAccess.
 * - Does NOT modify enforceModulePermissions.
 * - Safe to run multiple times.
 *
 * Put this file at:
 *   HIMS_Api-main/scripts/migrate-abdm-permissions.js
 *
 * PREVIEW:
 *   node scripts/migrate-abdm-permissions.js --hospital-id=YOUR_HOSPITAL_ID
 *
 * APPLY:
 *   node scripts/migrate-abdm-permissions.js --hospital-id=YOUR_HOSPITAL_ID --apply
 *
 * ALL HOSPITALS PREVIEW:
 *   node scripts/migrate-abdm-permissions.js --all-hospitals
 *
 * ALL HOSPITALS APPLY:
 *   node scripts/migrate-abdm-permissions.js --all-hospitals --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const argv = process.argv.slice(2);

const hasFlag = (name) => argv.includes(name);

const valueArg = (name) => {
  const inline = argv.find((item) => item.startsWith(`${name}=`));

  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = argv.indexOf(name);

  return index >= 0 ? argv[index + 1] : undefined;
};

const APPLY = hasFlag('--apply');
const ALL_HOSPITALS = hasFlag('--all-hospitals');
const HOSPITAL_ID = valueArg('--hospital-id');

/**
 * These roles previously had ABDM available through their normal
 * MediQliq workflow and therefore need the new explicit permission.
 */
const ABDM_LEGACY_ROLES = Object.freeze([
  'doctor',
  'nurse',
  'staff',
  'registrar',
  'receptionist'
]);

function normalizeRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

function serialize(value) {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (item instanceof mongoose.Types.ObjectId) {
        return String(item);
      }

      return item;
    },
    2
  );
}

async function main() {
  /**
   * -------------------------------
   * ARGUMENT VALIDATION
   * -------------------------------
   */

  if (HOSPITAL_ID && ALL_HOSPITALS) {
    throw new Error(
      'Use either --hospital-id or --all-hospitals, not both.'
    );
  }

  if (!HOSPITAL_ID && !ALL_HOSPITALS) {
    throw new Error(
      'Safety check: pass --hospital-id=<ObjectId> or explicitly pass --all-hospitals.'
    );
  }

  if (
    HOSPITAL_ID &&
    !mongoose.isValidObjectId(HOSPITAL_ID)
  ) {
    throw new Error(
      `Invalid --hospital-id: ${HOSPITAL_ID}`
    );
  }

  /**
   * -------------------------------
   * DATABASE CONNECTION
   * -------------------------------
   */

  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI;

  if (!uri) {
    throw new Error(
      'Set MONGODB_URI or MONGO_URI before running this migration.'
    );
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000
  });

  /**
   * Using the raw Mongo collection deliberately.
   *
   * This prevents this one-time migration from depending on
   * future User model schema/default changes.
   */
  const users =
    mongoose.connection.collection('users');

  /**
   * -------------------------------
   * FIND USERS NEEDING MIGRATION
   * -------------------------------
   *
   * IMPORTANT:
   *
   * If the user already has ANY abdm row:
   *
   *   abdm: manage
   *   abdm: view
   *   abdm: none
   *
   * we leave it alone.
   *
   * That existing permission is treated as an explicit
   * administrator decision.
   */

  const filter = {
    role: {
      $in: ABDM_LEGACY_ROLES
    },

    'modulePermissions.moduleKey': {
      $ne: 'abdm'
    }
  };

  if (HOSPITAL_ID) {
    filter.hospital_id =
      new mongoose.Types.ObjectId(HOSPITAL_ID);
  }

  const candidates = await users
    .find(
      filter,
      {
        projection: {
          name: 1,
          email: 1,
          role: 1,
          hospital_id: 1,
          is_active: 1,
          enforceModulePermissions: 1,
          sidebarAccess: 1,
          dashboard_access: 1,
          modulePermissions: 1
        }
      }
    )
    .sort({
      hospital_id: 1,
      role: 1,
      email: 1
    })
    .toArray();

  /**
   * -------------------------------
   * SUMMARY
   * -------------------------------
   */

  const byRole = {};

  for (const user of candidates) {
    const role = normalizeRole(user.role);

    byRole[role] =
      (byRole[role] || 0) + 1;
  }

  console.log(
    serialize({
      migration:
        'ADD_EXPLICIT_ABDM_MAIN_FEATURE_PERMISSION_V1',

      mode:
        APPLY
          ? 'APPLY'
          : 'PREVIEW',

      scope:
        HOSPITAL_ID
          ? {
              hospitalId: HOSPITAL_ID
            }
          : {
              allHospitals: true
            },

      policy: {
        roles: ABDM_LEGACY_ROLES,

        access: 'manage',

        preserveExistingAbdmRows: true,

        mutateSidebarAccess: false,

        mutateEnforceModulePermissions: false,

        addLegacyDashboardAccessKey: true
      },

      candidates: candidates.length,

      byRole
    })
  );

  if (!candidates.length) {
    console.log(
      'No users require ABDM permission migration. Nothing to do.'
    );

    return;
  }

  /**
   * -------------------------------
   * PRINT USERS
   * -------------------------------
   */

  for (const user of candidates) {
    console.log(
      `${
        APPLY
          ? 'WILL APPLY'
          : 'WOULD APPLY'
      }: ` +
        `${
          user.email ||
          user._id
        } ` +
        `(${normalizeRole(user.role)}) ` +
        `hospital=${
          user.hospital_id ||
          'none'
        } ` +
        `active=${
          user.is_active !== false
        }`
    );
  }

  /**
   * Stop here for dry run.
   */

  if (!APPLY) {
    console.log(
      '\nPreview only. Review the users above, then rerun with --apply.'
    );

    return;
  }

  /**
   * -------------------------------
   * APPLY MIGRATION
   * -------------------------------
   */

  const now = new Date();

  let updated = 0;
  let skippedRaceOrAlreadyMigrated = 0;

  for (const user of candidates) {
    const result =
      await users.updateOne(
        {
          _id: user._id,

          /**
           * Atomic idempotency guard.
           *
           * If someone adds/removes ABDM permission
           * between our query and update, we won't
           * accidentally create another row.
           */
          'modulePermissions.moduleKey': {
            $ne: 'abdm'
          }
        },

        {
          /**
           * Add explicit main-feature permission.
           */
          $push: {
            modulePermissions: {
              moduleKey: 'abdm',

              access: 'manage',

              actions: [],

              grantedAt: now,

              updatedAt: now
            }
          },

          /**
           * Preserve compatibility with older code
           * that still checks dashboard_access.
           *
           * $addToSet avoids duplicates.
           */
          $addToSet: {
            dashboard_access: 'abdm'
          },

          $set: {
            updatedAt: now
          }
        }
      );

    if (result.modifiedCount === 1) {
      updated += 1;
    } else {
      skippedRaceOrAlreadyMigrated += 1;
    }
  }

  /**
   * -------------------------------
   * VERIFY MIGRATION
   * -------------------------------
   */

  const remaining =
    await users.countDocuments(filter);

  const explicitAbdmFilter = {
    role: {
      $in: ABDM_LEGACY_ROLES
    },

    modulePermissions: {
      $elemMatch: {
        moduleKey: 'abdm',
        access: 'manage'
      }
    }
  };

  if (HOSPITAL_ID) {
    explicitAbdmFilter.hospital_id =
      new mongoose.Types.ObjectId(
        HOSPITAL_ID
      );
  }

  const explicitManageCount =
    await users.countDocuments(
      explicitAbdmFilter
    );

  console.log(
    '\n' +
      serialize({
        result: 'complete',

        updated,

        skippedRaceOrAlreadyMigrated,

        remainingMissingAbdmRows:
          remaining,

        explicitAbdmManageUsersInScope:
          explicitManageCount
      })
  );

  /**
   * A non-zero result means something prevented
   * one or more intended users from being updated.
   */
  if (remaining !== 0) {
    process.exitCode = 2;

    console.error(
      'WARNING: some intended legacy ABDM users are still missing an explicit ABDM row.'
    );
  }
}

/**
 * -------------------------------
 * RUN
 * -------------------------------
 */

main()
  .catch((error) => {
    console.error(
      error?.stack ||
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection
      .close()
      .catch(() => {});
  });