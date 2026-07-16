#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (_) { /* dotenv is optional for export-only dry runs */ }

function loadDatabaseDependencies() {
  return {
    mongoose: require('mongoose'),
    connectDB: require('../config/db'),
    LabTest: require('../models/LabTest')
  };
}

function isValidObjectId(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || ''));
}

let reportTemplateCatalog = { templates: [] };
try {
  // Optional: available after applying the structured-report implementation.
  // The script still works without this file.
  reportTemplateCatalog = require('../data/labReportTemplates.json');
} catch (_) {
  reportTemplateCatalog = { templates: [] };
}

/**
 * Starter INR pricing policy.
 *
 * Existing positive prices are preserved unless --overwrite-prices is supplied.
 * Adjust these values to your hospital's approved tariff before applying in production,
 * or supply exact overrides through --pricing-file=/path/pricing.json.
 */
const DEFAULT_CATEGORY_PRICES = Object.freeze({
  Hematology: 250,
  Biochemistry: 300,
  Microbiology: 500,
  Immunology: 550,
  Pathology: 700,
  Serology: 450,
  Toxicology: 700,
  Endocrinology: 550,
  Cardiology: 1000,
  Radiology: 1200,
  'Molecular Diagnostics': 1800,
  'Genetic Testing': 2500,
  Other: 400
});

// Minimum prices for clearly identifiable high-complexity or non-laboratory investigations
// that currently live in the LabTest collection.
const NAME_PRICE_FLOORS = Object.freeze([
  { pattern: /angiograph/i, price: 5000 },
  { pattern: /magnetic resonance|\bmri\b/i, price: 4500 },
  { pattern: /computed tomography|\bct scan\b/i, price: 3000 },
  { pattern: /karyotype|fish|genetic|chromosome/i, price: 3000 },
  { pattern: /viral load/i, price: 2500 },
  { pattern: /gene.?xpert|cbnaat|\bnaat\b|\bpcr\b/i, price: 1800 },
  { pattern: /histopathology/i, price: 1500 },
  { pattern: /tb drug susceptibility|tb culture/i, price: 1500 },
  { pattern: /echocardiograph/i, price: 1500 },
  { pattern: /electromyograph|nerve conduction|\bemg\b|\bncv\b/i, price: 1500 },
  { pattern: /mammograph/i, price: 1500 },
  { pattern: /ultrasound|doppler/i, price: 1200 },
  { pattern: /electroencephalograph|\beeg\b/i, price: 1200 },
  { pattern: /treadmill|\btmt\b/i, price: 1000 },
  { pattern: /blood culture.*sensitivity/i, price: 1000 },
  { pattern: /culture.*sensitivity|sensitivity.*culture/i, price: 800 },
  { pattern: /pulmonary function|\bpft\b/i, price: 800 },
  { pattern: /pap smear|fnac|fine needle aspiration/i, price: 700 },
  { pattern: /x-?ray|radiograph/i, price: 500 }
]);

function parseNumber(value, optionName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${optionName} must be a non-negative number`);
  }
  return number;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    hospitalId: '',
    globalOnly: false,
    templatesOnly: false,
    overwritePrices: false,
    flatPrice: null,
    fallbackPrice: 300,
    pricingFile: '',
    exportPath: '',
    reportPath: '',
    help: false
  };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--global-only') options.globalOnly = true;
    else if (argument === '--templates-only') options.templatesOnly = true;
    else if (argument === '--overwrite-prices') options.overwritePrices = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--hospital=')) options.hospitalId = argument.slice('--hospital='.length);
    else if (argument.startsWith('--flat-price=')) options.flatPrice = parseNumber(argument.slice('--flat-price='.length), '--flat-price');
    else if (argument.startsWith('--fallback-price=')) options.fallbackPrice = parseNumber(argument.slice('--fallback-price='.length), '--fallback-price');
    else if (argument.startsWith('--pricing-file=')) options.pricingFile = argument.slice('--pricing-file='.length);
    else if (argument.startsWith('--export=')) options.exportPath = argument.slice('--export='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (options.hospitalId && options.globalOnly) {
    throw new Error('Use either --hospital or --global-only, not both');
  }
  return options;
}

function printHelp() {
  console.log(`
Activate lab tests and populate missing prices.

Dry run across the complete LabTest collection:
  node scripts/activateAllLabTestsAndSetPricing.js

Apply activation and fill zero/missing prices:
  node scripts/activateAllLabTestsAndSetPricing.js --apply

Hospital/global scopes:
  node scripts/activateAllLabTestsAndSetPricing.js --hospital=<hospitalObjectId> --apply
  node scripts/activateAllLabTestsAndSetPricing.js --global-only --apply

Pricing options:
  --overwrite-prices       Recalculate even when base_price is already greater than zero
  --flat-price=500         Use one price for every selected test
  --fallback-price=300     Final fallback when no category or name rule matches
  --pricing-file=FILE      JSON overrides by code, exact name, category and fallback
  --templates-only         Update only tests linked to one of the 105 report templates

Audit an exported MongoDB JSON array without connecting:
  node scripts/activateAllLabTestsAndSetPricing.js --export=/path/test.labtests.json

Optional report:
  --report=/path/activation-pricing-audit.json

Pricing-file format:
{
  "currency": "INR",
  "fallback": 300,
  "byCategory": { "Biochemistry": 350 },
  "byCode": { "LT-HAEM-009": 400 },
  "byName": { "Complete Blood Count (CBC)": 400 }
}

The command is a dry run unless --apply is supplied.
`);
}

function mongoValue(value) {
  if (value && typeof value === 'object') {
    if ('$oid' in value) return value.$oid;
    if ('$numberDecimal' in value) return Number(value.$numberDecimal);
  }
  return value;
}

function readExport(exportPath) {
  const resolved = path.resolve(exportPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('The export must contain a JSON array');
  return parsed.map((item) => ({
    ...item,
    _id: mongoValue(item._id),
    hospitalId: mongoValue(item.hospitalId),
    base_price: Number(mongoValue(item.base_price) || 0)
  }));
}

function loadPricingOverrides(pricingFile) {
  if (!pricingFile) {
    return { currency: 'INR', byCategory: {}, byCode: {}, byName: {}, fallback: null };
  }

  const resolved = path.resolve(pricingFile);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const result = {
    currency: String(parsed.currency || 'INR'),
    byCategory: parsed.byCategory || {},
    byCode: parsed.byCode || {},
    byName: parsed.byName || {},
    fallback: parsed.fallback == null ? null : parseNumber(parsed.fallback, 'pricing-file fallback')
  };

  for (const [groupName, group] of Object.entries({
    byCategory: result.byCategory,
    byCode: result.byCode,
    byName: result.byName
  })) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`pricing-file ${groupName} must be an object`);
    }
    for (const [key, value] of Object.entries(group)) {
      group[key] = parseNumber(value, `pricing-file ${groupName}.${key}`);
    }
  }
  return result;
}

function buildTemplateObservationCountMap() {
  const map = new Map();
  for (const template of reportTemplateCatalog.templates || []) {
    map.set(template.id, Array.isArray(template.observations) ? template.observations.length : 0);
  }
  return map;
}

const TEMPLATE_OBSERVATION_COUNTS = buildTemplateObservationCountMap();

function scopeFilter(options, mongooseInstance = null) {
  const filter = {};
  if (options.hospitalId) {
    filter.hospitalId = mongooseInstance
      ? new mongooseInstance.Types.ObjectId(options.hospitalId)
      : options.hospitalId;
  }
  else if (options.globalOnly) filter.$or = [{ hospitalId: null }, { hospitalId: { $exists: false } }];
  if (options.templatesOnly) filter.report_template_id = { $exists: true, $nin: [null, ''] };
  return filter;
}

function exportedTestInScope(test, options) {
  if (options.hospitalId && String(test.hospitalId || '') !== options.hospitalId) return false;
  if (options.globalOnly && test.hospitalId != null && test.hospitalId !== '') return false;
  if (options.templatesOnly && !test.report_template_id) return false;
  return true;
}

function caseInsensitiveLookup(object, key) {
  const target = String(key || '').trim().toLowerCase();
  if (!target) return null;
  for (const [candidate, value] of Object.entries(object || {})) {
    if (candidate.trim().toLowerCase() === target) return value;
  }
  return null;
}

function roundedPrice(value) {
  // Hospital tariffs are easier to maintain in multiples of 10.
  return Math.max(0, Math.round(Number(value) / 10) * 10);
}

function calculatePrice(test, options, overrides) {
  if (options.flatPrice != null) return roundedPrice(options.flatPrice);

  const codeOverride = caseInsensitiveLookup(overrides.byCode, test.code);
  if (codeOverride != null) return roundedPrice(codeOverride);

  const nameOverride = caseInsensitiveLookup(overrides.byName, test.name);
  if (nameOverride != null) return roundedPrice(nameOverride);

  const categoryOverride = caseInsensitiveLookup(overrides.byCategory, test.category);
  const categoryBase = categoryOverride
    ?? caseInsensitiveLookup(DEFAULT_CATEGORY_PRICES, test.category)
    ?? overrides.fallback
    ?? options.fallbackPrice;

  let price = Number(categoryBase);
  const name = `${test.name || ''} ${test.report_template_name || ''}`;

  for (const rule of NAME_PRICE_FLOORS) {
    if (rule.pattern.test(name)) price = Math.max(price, rule.price);
  }

  // Add a modest panel-complexity amount when a structured template contains multiple observations.
  // This does not affect tests without a linked template.
  const analyteCount = TEMPLATE_OBSERVATION_COUNTS.get(test.report_template_id) || 0;
  if (analyteCount > 1) {
    price += Math.min(1000, (analyteCount - 1) * 60);
  }

  return roundedPrice(Math.max(price, overrides.fallback ?? options.fallbackPrice));
}

function buildPlan(tests, options, overrides) {
  const changes = [];
  for (const test of tests) {
    const currentPrice = Number(test.base_price || 0);
    const shouldSetPrice = options.overwritePrices || currentPrice <= 0;
    const proposedPrice = shouldSetPrice
      ? calculatePrice(test, options, overrides)
      : currentPrice;

    changes.push({
      id: String(test._id),
      code: test.code || '',
      name: test.name || '',
      category: test.category || 'Other',
      hospitalId: test.hospitalId ? String(test.hospitalId) : null,
      reportTemplateId: test.report_template_id || null,
      wasActive: test.is_active === true,
      currentPrice,
      proposedPrice,
      willActivate: test.is_active !== true,
      willSetPrice: shouldSetPrice && proposedPrice !== currentPrice
    });
  }
  return changes;
}

function summarize(plan, overrides, options) {
  const proposed = plan.map((item) => item.proposedPrice);
  const sum = proposed.reduce((total, price) => total + price, 0);
  return {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'APPLY' : 'DRY_RUN',
    currency: overrides.currency || 'INR',
    selectedTests: plan.length,
    currentlyActive: plan.filter((item) => item.wasActive).length,
    currentlyInactive: plan.filter((item) => !item.wasActive).length,
    testsToActivate: plan.filter((item) => item.willActivate).length,
    existingPositivePrices: plan.filter((item) => item.currentPrice > 0).length,
    testsToPrice: plan.filter((item) => item.willSetPrice).length,
    preservedPrices: plan.filter((item) => !item.willSetPrice && item.currentPrice > 0).length,
    proposedMinimumPrice: proposed.length ? Math.min(...proposed) : 0,
    proposedMaximumPrice: proposed.length ? Math.max(...proposed) : 0,
    proposedAveragePrice: proposed.length ? Math.round(sum / proposed.length) : 0,
    changes: plan
  };
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Detailed report written to ${resolved}`);
}

function printSummary(report) {
  console.log('\nLab-test activation and pricing audit');
  console.log('-------------------------------------');
  console.log(`Mode:                    ${report.mode}`);
  console.log(`Selected tests:          ${report.selectedTests}`);
  console.log(`Active / inactive:       ${report.currentlyActive} / ${report.currentlyInactive}`);
  console.log(`Tests to activate:       ${report.testsToActivate}`);
  console.log(`Existing positive prices:${String(report.existingPositivePrices).padStart(2, ' ')}`);
  console.log(`Prices to add/change:    ${report.testsToPrice}`);
  console.log(`Preserved prices:        ${report.preservedPrices}`);
  console.log(`Price range (${report.currency}): ${report.proposedMinimumPrice} - ${report.proposedMaximumPrice}`);
  console.log(`Average (${report.currency}):     ${report.proposedAveragePrice}`);

  const preview = report.changes.filter((item) => item.willActivate || item.willSetPrice).slice(0, 20);
  if (preview.length) {
    console.log('\nFirst planned changes:');
    for (const item of preview) {
      const activation = item.willActivate ? 'activate' : 'keep active';
      const pricing = item.willSetPrice
        ? `${item.currentPrice} -> ${item.proposedPrice}`
        : `keep ${item.currentPrice}`;
      console.log(`  ${item.code.padEnd(14)} ${activation.padEnd(11)} price ${pricing.padEnd(14)} ${item.name}`);
    }
    if (report.changes.length > preview.length) console.log('  ...');
  }
}

async function applyPlan(plan, LabTest) {
  const now = new Date();
  const operations = plan.map((item) => {
    const set = { is_active: true, updatedAt: now };
    if (item.willSetPrice) set.base_price = item.proposedPrice;
    return {
      updateOne: {
        filter: { _id: item.id },
        update: { $set: set }
      }
    };
  });

  if (!operations.length) return { matchedCount: 0, modifiedCount: 0 };
  return LabTest.bulkWrite(operations, { ordered: false });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.hospitalId && !isValidObjectId(options.hospitalId)) {
    throw new Error('--hospital must be a valid MongoDB ObjectId');
  }
  if (options.exportPath && options.apply) {
    throw new Error('--apply cannot be used with --export; connect to MongoDB to write changes');
  }

  const overrides = loadPricingOverrides(options.pricingFile);
  let connected = false;
  let mongoose;
  try {
    let tests;
    if (options.exportPath) {
      tests = readExport(options.exportPath).filter((test) => exportedTestInScope(test, options));
    } else {
      if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required when --export is not supplied');
      const dependencies = loadDatabaseDependencies();
      mongoose = dependencies.mongoose;
      await dependencies.connectDB();
      connected = true;
      tests = await dependencies.LabTest.find(scopeFilter(options, mongoose))
        .select('_id hospitalId code name category base_price is_active report_template_id report_template_name')
        .lean();
    }

    const plan = buildPlan(tests, options, overrides);
    const report = summarize(plan, overrides, options);
    printSummary(report);
    writeReport(options.reportPath, report);

    if (!options.apply) {
      console.log('\nDry run only. Review the tariff and run again with --apply.');
      return;
    }

    const { LabTest } = loadDatabaseDependencies();
    const result = await applyPlan(plan, LabTest);
    console.log('\nActivation and pricing completed:');
    console.log(`  matched:  ${result.matchedCount || 0}`);
    console.log(`  modified: ${result.modifiedCount || 0}`);
  } finally {
    if (connected && mongoose) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nLab-test activation/pricing failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CATEGORY_PRICES,
  NAME_PRICE_FLOORS,
  buildPlan,
  calculatePrice,
  parseArgs,
  scopeFilter
};
