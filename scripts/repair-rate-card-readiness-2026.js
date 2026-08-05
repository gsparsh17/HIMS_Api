#!/usr/bin/env node
'use strict';

/**
 * Repair existing rate-card readiness data after the insurance platform patch.
 *
 * Safe default: preview only. Writes require --apply.
 *
 * Repairs supported by source data:
 * - inherit a card-level annexure/page-range into items that have no row reference;
 * - load verified replacement names for source-name placeholders;
 * - generate conservative mapping suggestions (never approvals);
 * - validate and persist the refreshed quality summary.
 *
 * Usage:
 *   node scripts/repair-rate-card-readiness-2026.js --hospital-id=<id>
 *   node scripts/repair-rate-card-readiness-2026.js --hospital-id=<id> --apply
 *   node scripts/repair-rate-card-readiness-2026.js --hospital-id=<id> \
 *     --rate-card-id=<id> --verified-names=./data/cghs-verified-names.json --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const RateCard = require('../models/RateCard');
const { prepareRateCardReadiness } = require('../services/rateCardReadiness.service');

function parseArgs(argv) {
  const result = {
    apply: false,
    hospitalId: '',
    rateCardId: '',
    mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
    verifiedNamesPath: '',
    suggest: true,
    threshold: 0.65,
    limitPerItem: 5,
    overwriteSuggested: false,
    reportPath: ''
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') result.apply = true;
    else if (arg === '--no-suggest') result.suggest = false;
    else if (arg === '--overwrite-suggested') result.overwriteSuggested = true;
    else if (arg.startsWith('--hospital-id=')) result.hospitalId = arg.slice('--hospital-id='.length);
    else if (arg.startsWith('--rate-card-id=')) result.rateCardId = arg.slice('--rate-card-id='.length);
    else if (arg.startsWith('--mongo-uri=')) result.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg.startsWith('--verified-names=')) result.verifiedNamesPath = arg.slice('--verified-names='.length);
    else if (arg.startsWith('--threshold=')) result.threshold = Number(arg.slice('--threshold='.length));
    else if (arg.startsWith('--limit-per-item=')) result.limitPerItem = Number(arg.slice('--limit-per-item='.length));
    else if (arg.startsWith('--report=')) result.reportPath = arg.slice('--report='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');
  if (!mongoose.isValidObjectId(result.hospitalId)) throw new Error('--hospital-id=<ObjectId> is required');
  if (result.rateCardId && !mongoose.isValidObjectId(result.rateCardId)) throw new Error('--rate-card-id must be a valid ObjectId');
  if (!Number.isFinite(result.threshold) || result.threshold < 0 || result.threshold > 1) throw new Error('--threshold must be between 0 and 1');
  if (!Number.isInteger(result.limitPerItem) || result.limitPerItem < 1 || result.limitPerItem > 20) throw new Error('--limit-per-item must be between 1 and 20');
  return result;
}

function loadVerifiedNames(filePath) {
  if (!filePath) return {};
  const absolute = path.resolve(filePath);
  const payload = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Verified names file must be a JSON object keyed by external code');
  return payload;
}

async function main() {
  const args = parseArgs(process.argv);
  await mongoose.connect(args.mongoUri);
  const hospitalId = new mongoose.Types.ObjectId(args.hospitalId);
  const filter = { hospitalId };
  if (args.rateCardId) filter._id = new mongoose.Types.ObjectId(args.rateCardId);
  const cards = await RateCard.find(filter).sort({ effectiveFrom: -1 }).lean();
  if (!cards.length) throw new Error('No matching rate cards found');

  const verifiedNames = loadVerifiedNames(args.verifiedNamesPath);
  const report = {
    mode: args.apply ? 'apply' : 'preview',
    hospitalId: args.hospitalId,
    rateCardId: args.rateCardId || null,
    generatedAt: new Date().toISOString(),
    cards: []
  };

  for (const card of cards) {
    const result = await prepareRateCardReadiness({
      hospitalId,
      rateCardId: card._id,
      persist: args.apply,
      suggest: args.suggest,
      threshold: args.threshold,
      limitPerItem: args.limitPerItem,
      overwriteSuggested: args.overwriteSuggested,
      verifiedNames
    });
    report.cards.push({
      id: String(card._id),
      payerId: String(card.payerId),
      version: card.version,
      sourceReference: result.source,
      verifiedNames: {
        supplied: result.names.supplied,
        matched: result.names.matched,
        wouldUpdate: result.names.wouldUpdate,
        updated: result.names.updated,
        missingCodes: result.names.missingCodes
      },
      legacyRates: {
        legacyRowsFound: result.legacyRates.legacyRowsFound,
        eligible: result.legacyRates.eligible,
        wouldUpdate: result.legacyRates.wouldUpdate,
        updated: result.legacyRates.updated
      },
      mappings: result.mappings ? {
        evaluated: result.mappings.evaluated,
        suggested: result.mappings.suggested,
        noMatch: result.mappings.noMatch,
        persisted: result.mappings.persisted
      } : null,
      qualityBasis: result.qualityBasis,
      quality: {
        criticalErrors: result.quality.criticalErrors,
        warnings: result.quality.warnings,
        informational: result.quality.informational,
        mappingPending: result.quality.mappingPending,
        packageScopePending: result.quality.packageScopePending,
        unresolvedSourceNames: result.quality.unresolvedSourceNames,
        sourceTraceabilityErrors: result.quality.sourceTraceabilityErrors
      },
      mappingPercentage: result.mappingPercentage,
      activationReady: result.activationGate.ready,
      activationReasons: result.activationGate.reasons
    });
  }

  const output = JSON.stringify(report, null, 2);
  if (args.reportPath) fs.writeFileSync(path.resolve(args.reportPath), output);
  console.log(output);
  if (!args.apply) console.log('\nPREVIEW ONLY: rerun with --apply after reviewing this report.');
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
