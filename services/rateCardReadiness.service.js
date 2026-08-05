'use strict';

const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const { suggestMappings } = require('./tariffMapping.service');
const { validateRateCard } = require('./tariffValidation.service');

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedNames(input = {}) {
  const result = new Map();
  for (const [code, name] of Object.entries(input || {})) {
    const cleanCode = compact(code).toUpperCase();
    const cleanName = compact(name);
    if (cleanCode && cleanName) result.set(cleanCode, cleanName);
  }
  return result;
}

function canonicalExactWardRates(input = {}) {
  const aliases = [
    ['general', 'general'],
    ['semi_private', 'semiPrivate'],
    ['semiPrivate', 'semiPrivate'],
    ['private', 'private'],
    ['icu', 'icu'],
    ['day_care', 'dayCare'],
    ['dayCare', 'dayCare'],
    ['not_applicable', 'notApplicable'],
    ['notApplicable', 'notApplicable']
  ];
  const result = {};
  for (const [sourceKey, targetKey] of aliases) {
    const raw = input?.[sourceKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const amount = Number(raw);
    if (Number.isFinite(amount) && amount >= 0) result[targetKey] = amount;
  }
  return result;
}

function sameWardRates(left = {}, right = {}) {
  const keys = ['general', 'semiPrivate', 'private', 'icu', 'dayCare', 'notApplicable'];
  return keys.every((key) => {
    const a = left?.[key];
    const b = right?.[key];
    if (a === undefined && b === undefined) return true;
    return Number(a) === Number(b);
  });
}

async function inheritCardSourceReference({ hospitalId, rateCardId, persist = true }) {
  const card = await RateCard.findOne({ _id: rateCardId, hospitalId });
  if (!card) {
    const error = new Error('Rate card not found');
    error.statusCode = 404;
    throw error;
  }

  const cardReference = compact(card.source?.pageOrAnnexure);
  if (!cardReference) {
    return { cardReference: '', eligible: 0, wouldUpdate: 0, updated: 0, note: 'Rate card has no annexure/page-range reference to inherit' };
  }

  const items = await RateCardItem.find({
    hospitalId,
    rateCardId: card._id,
    $and: [
      { $or: [{ 'sourceRow.page': { $exists: false } }, { 'sourceRow.page': null }] },
      { $or: [{ 'sourceRow.sheet': { $exists: false } }, { 'sourceRow.sheet': '' }, { 'sourceRow.sheet': null }] },
      { $or: [{ 'sourceRow.annexure': { $exists: false } }, { 'sourceRow.annexure': '' }, { 'sourceRow.annexure': null }] }
    ]
  }).select('_id sourceRow externalCode');

  if (persist && items.length) {
    const now = new Date();
    await RateCardItem.bulkWrite(items.map((item) => ({
      updateOne: {
        filter: { _id: item._id, hospitalId, rateCardId: card._id },
        update: {
          $set: {
            'sourceRow.annexure': cardReference,
            'sourceRow.raw.sourceReferenceInheritedFromRateCard': true,
            'sourceRow.raw.sourceReferenceInheritedAt': now
          }
        }
      }
    })), { ordered: false });
  }

  return { cardReference, eligible: items.length, wouldUpdate: items.length, updated: persist ? items.length : 0 };
}

async function applyVerifiedSourceNames({ hospitalId, rateCardId, names = {}, persist = true }) {
  const nameMap = normalizedNames(names);
  if (!nameMap.size) return { supplied: 0, matched: 0, wouldUpdate: 0, updated: 0, missingCodes: [], previewNameMap: nameMap };

  const items = await RateCardItem.find({
    hospitalId,
    rateCardId,
    externalCode: { $in: [...nameMap.keys()] }
  }).select('_id externalCode externalName sourceRow');

  const operations = [];
  const matchedCodes = new Set();
  for (const item of items) {
    const code = compact(item.externalCode).toUpperCase();
    const name = nameMap.get(code);
    if (!name) continue;
    matchedCodes.add(code);
    const alreadyVerified = compact(item.externalName) === name && item.sourceRow?.raw?.sourceNameMissing !== true;
    if (alreadyVerified) continue;
    operations.push({
      updateOne: {
        filter: { _id: item._id, hospitalId, rateCardId },
        update: {
          $set: {
            externalName: name,
            'sourceRow.raw.sourceNameMissing': false,
            'sourceRow.raw.sourceNameVerified': true,
            'sourceRow.raw.sourceNameVerifiedAt': new Date()
          }
        }
      }
    });
  }

  if (persist && operations.length) await RateCardItem.bulkWrite(operations, { ordered: false });
  return {
    supplied: nameMap.size,
    matched: matchedCodes.size,
    wouldUpdate: operations.length,
    updated: persist ? operations.length : 0,
    missingCodes: [...nameMap.keys()].filter((code) => !matchedCodes.has(code)),
    previewNameMap: nameMap
  };
}

async function migrateLegacyRateShapes({ hospitalId, rateCardId, persist = true }) {
  // Use the native collection because wardRates is a retired field and is not
  // declared in the canonical RateCardItem schema.
  const rows = await RateCardItem.collection.find({
    hospitalId,
    rateCardId,
    wardRates: { $exists: true, $type: 'object' }
  }).project({ _id: 1, wardRates: 1, rates: 1, pricingMode: 1, billingUnit: 1, packageDefinition: 1 }).toArray();

  const operations = [];
  const previewRatesById = new Map();
  for (const row of rows) {
    const legacy = canonicalExactWardRates(row.wardRates || {});
    if (!Object.keys(legacy).length) continue;
    const existing = canonicalExactWardRates(row.rates?.exactWard || {});
    const exactWard = { ...legacy, ...existing };
    const pricingMode = row.pricingMode === 'package' || row.packageDefinition?.isPackage || row.billingUnit === 'package'
      ? 'package'
      : 'exact_ward';
    const changed = !sameWardRates(existing, exactWard) || row.pricingMode !== pricingMode || row.wardRates !== undefined;
    if (!changed) continue;
    previewRatesById.set(String(row._id), {
      pricingMode,
      rates: { ...(row.rates || {}), exactWard }
    });
    operations.push({
      updateOne: {
        filter: { _id: row._id, hospitalId, rateCardId },
        update: {
          $set: {
            pricingMode,
            'rates.exactWard': exactWard,
            'sourceRow.raw.legacyWardRatesMigrated': true,
            'sourceRow.raw.legacyWardRatesMigratedAt': new Date()
          },
          $unset: { wardRates: '' }
        }
      }
    });
  }

  if (persist && operations.length) await RateCardItem.collection.bulkWrite(operations, { ordered: false });
  return {
    legacyRowsFound: rows.length,
    eligible: operations.length,
    wouldUpdate: operations.length,
    updated: persist ? operations.length : 0,
    previewRatesById
  };
}

async function prepareRateCardReadiness({
  hospitalId,
  rateCardId,
  userId,
  persist = true,
  suggest = true,
  threshold = 0.65,
  limitPerItem = 5,
  overwriteSuggested = false,
  verifiedNames = {}
}) {
  const source = await inheritCardSourceReference({ hospitalId, rateCardId, persist });
  const names = await applyVerifiedSourceNames({ hospitalId, rateCardId, names: verifiedNames, persist });
  const legacyRates = await migrateLegacyRateShapes({ hospitalId, rateCardId, persist });
  const mappings = suggest
    ? await suggestMappings({
      hospitalId,
      rateCardId,
      threshold,
      limitPerItem,
      overwriteSuggested,
      userId,
      persist
    })
    : null;
  const validation = await validateRateCard({
    hospitalId,
    rateCardId,
    persist,
    previewMutations: persist ? undefined : {
      inheritedAnnexure: source.cardReference,
      verifiedNames: names.previewNameMap,
      legacyRatesById: legacyRates.previewRatesById
    }
  });
  return {
    source,
    names,
    legacyRates,
    mappings,
    qualityBasis: persist ? 'persisted_after_repair' : 'projected_after_repair',
    quality: validation.quality,
    mappingPercentage: validation.mappingPercentage,
    activationGate: validation.gate,
    itemCount: validation.itemCount
  };
}

module.exports = {
  normalizedNames,
  canonicalExactWardRates,
  inheritCardSourceReference,
  applyVerifiedSourceNames,
  migrateLegacyRateShapes,
  prepareRateCardReadiness
};
