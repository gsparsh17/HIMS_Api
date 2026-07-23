#!/usr/bin/env node

/*
 * One-time migration for the OT, Store, patient-file and digital-signature platform.
 *
 * Usage:
 *   node scripts/migrate-ot-store-document-platform.js
 *   node scripts/migrate-ot-store-document-platform.js --apply
 *
 * This script migrates data and the consent index required by this migration.
 * It does not synchronize unrelated model indexes.
 */

require('dotenv').config();

const mongoose = require('mongoose');

// Disable automatic index work before any model is imported.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const IPDConsent = require('../models/IPDConsent');
const OTRequest = require('../models/OTRequest');
const OTSchedule = require('../models/OTSchedule');
const OTStaff = require('../models/OTStaff');
const StoreItem = require('../models/StoreItem');
const StoreInventoryTransaction = require(
  '../models/StoreInventoryTransaction'
);

const apply = process.argv.includes('--apply');
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

function missingRawField(field) {
  return {
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: '' }
    ]
  };
}

function presentRawField(field) {
  return {
    [field]: {
      $exists: true,
      $nin: [null, '']
    }
  };
}

function asObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  if (!mongoose.isValidObjectId(value)) {
    return null;
  }

  return new mongoose.Types.ObjectId(String(value));
}

function sameIndexKey(actual = {}, expected = {}) {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);

  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => {
      const [expectedKey, expectedValue] =
        expectedEntries[index] || [];

      return key === expectedKey && value === expectedValue;
    });
}

async function updateMissingHospital(
  Model,
  sourceField,
  targetField,
  sourceModel
) {
  /*
   * Use the native MongoDB collection API here.
   *
   * Some legacy ObjectId fields contain an empty string. A Mongoose query such
   * as { hospitalId: '' } attempts to cast '' to ObjectId before MongoDB sees
   * the filter and throws a CastError. Native collection filters can safely
   * identify those malformed legacy values.
   */
  const filter = {
    $and: [
      missingRawField(targetField),
      presentRawField(sourceField)
    ]
  };

  const cursor = Model.collection.find(
    filter,
    {
      projection: {
        _id: 1,
        [sourceField]: 1
      }
    }
  );

  const result = {
    matched: 0,
    updated: 0,
    unresolved: 0,
    unresolvedIds: []
  };

  for await (const record of cursor) {
    result.matched += 1;

    const sourceId = asObjectId(record[sourceField]);

    if (!sourceId) {
      result.unresolved += 1;
      result.unresolvedIds.push(String(record._id));
      continue;
    }

    const source = await sourceModel.collection.findOne(
      {
        _id: sourceId
      },
      {
        projection: {
          hospitalId: 1,
          hospital_id: 1
        }
      }
    );

    const hospitalId = asObjectId(
      source?.hospitalId || source?.hospital_id
    );

    if (!hospitalId) {
      result.unresolved += 1;
      result.unresolvedIds.push(String(record._id));
      continue;
    }

    if (apply) {
      const updateResult = await Model.collection.updateOne(
        {
          $and: [
            {
              _id: record._id
            },
            missingRawField(targetField)
          ]
        },
        {
          $set: {
            [targetField]: hospitalId
          }
        }
      );

      result.updated += updateResult.modifiedCount || 0;
    }
  }

  return result;
}

async function migrateConsentIndex() {
  const collection = IPDConsent.collection;
  const desiredKey = {
    hospitalId: 1,
    admissionId: 1,
    templateId: 1,
    scopeKey: 1
  };
  const desiredName =
    'hospitalId_1_admissionId_1_templateId_1_scopeKey_1';

  const duplicates = await collection.aggregate([
    {
      $group: {
        _id: {
          hospitalId: '$hospitalId',
          admissionId: '$admissionId',
          templateId: '$templateId',
          scopeKey: '$scopeKey'
        },
        count: {
          $sum: 1
        },
        documentIds: {
          $push: '$_id'
        }
      }
    },
    {
      $match: {
        count: {
          $gt: 1
        }
      }
    },
    {
      $limit: 20
    }
  ]).toArray();

  if (duplicates.length) {
    throw new Error(
      'Cannot create the consent unique index because duplicate '
      + `consent scopes exist: ${JSON.stringify(duplicates)}`
    );
  }

  let indexes = await collection.indexes();

  const desiredIndex = indexes.find((index) =>
    sameIndexKey(index.key, desiredKey)
  );

  const result = {
    desiredIndexPresent: Boolean(
      desiredIndex && desiredIndex.unique
    ),
    desiredIndexCreated: false,
    legacyIndexes: [],
    legacyIndexesDropped: []
  };

  if (desiredIndex && !desiredIndex.unique) {
    throw new Error(
      `Consent index ${desiredIndex.name} has the correct fields `
      + 'but is not unique. Review and replace it manually.'
    );
  }

  if (!desiredIndex && apply) {
    await collection.createIndex(
      desiredKey,
      {
        unique: true,
        name: desiredName
      }
    );

    result.desiredIndexCreated = true;
  }

  indexes = await collection.indexes();

  const legacyIndexes = indexes.filter((index) =>
    index.unique
    && index.key?.admissionId === 1
    && index.key?.templateId === 1
    && index.key?.scopeKey !== 1
  );

  result.legacyIndexes = legacyIndexes.map(
    (index) => index.name
  );

  if (apply) {
    for (const index of legacyIndexes) {
      await collection.dropIndex(index.name);
      result.legacyIndexesDropped.push(index.name);
    }
  }

  return result;
}

async function main() {
  if (!mongoUri) {
    throw new Error('MONGODB_URI or MONGO_URI is required');
  }

  await mongoose.connect(
    mongoUri,
    {
      autoIndex: false,
      autoCreate: false
    }
  );

  const IPDAdmission = require('../models/IPDAdmission');
  const User = require('../models/User');

  const report = {};

  const otRequests = await updateMissingHospital(
    OTRequest,
    'admissionId',
    'hospitalId',
    IPDAdmission
  );

  const otSchedules = await updateMissingHospital(
    OTSchedule,
    'requestId',
    'hospitalId',
    OTRequest
  );

  const otStaff = await updateMissingHospital(
    OTStaff,
    'userId',
    'hospitalId',
    User
  );

  const consents = await updateMissingHospital(
    IPDConsent,
    'admissionId',
    'hospitalId',
    IPDAdmission
  );

  report.otRequestsMissingHospital = otRequests.matched;
  report.otSchedulesMissingHospital = otSchedules.matched;
  report.otStaffMissingHospital = otStaff.matched;
  report.consentsMissingHospital = consents.matched;

  report.hospitalBackfill = {
    otRequests,
    otSchedules,
    otStaff,
    consents
  };

  const consentFilter = missingRawField('scopeKey');

  report.consentsMissingScopeKey =
    await IPDConsent.collection.countDocuments(consentFilter);

  if (apply && report.consentsMissingScopeKey > 0) {
    await IPDConsent.collection.updateMany(
      consentFilter,
      {
        $set: {
          scopeKey: 'admission',
          formRevision: 1
        }
      }
    );
  }

  report.storeItemsMissingHospital =
    await StoreItem.collection.countDocuments(
      missingRawField('hospital_id')
    );

  report.legacyTransactionsWithoutEventId =
    await StoreInventoryTransaction.collection.countDocuments(
      missingRawField('eventId')
    );

  report.consentIndexes = apply
    ? await migrateConsentIndex()
    : {
        note:
          'Consent index changes were not performed in dry-run mode.'
      };

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        report
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
