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

const CONFIRMATION = 'DEACTIVATE_ALL_LAB_TESTS';

function parseArgs(argv) {
  const options = {
    apply: false,
    confirmation: '',
    hospitalId: '',
    globalOnly: false,
    templatesOnly: false,
    exportPath: '',
    reportPath: '',
    help: false
  };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--global-only') options.globalOnly = true;
    else if (argument === '--templates-only') options.templatesOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--confirm=')) options.confirmation = argument.slice('--confirm='.length);
    else if (argument.startsWith('--hospital=')) options.hospitalId = argument.slice('--hospital='.length);
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
Deactivate lab tests without changing their prices or template links.

Dry run across the complete LabTest collection:
  node scripts/deactivateAllLabTests.js

Apply across all hospital/global scopes:
  node scripts/deactivateAllLabTests.js --apply --confirm=${CONFIRMATION}

Limit the operation:
  node scripts/deactivateAllLabTests.js --hospital=<hospitalObjectId> --apply --confirm=${CONFIRMATION}
  node scripts/deactivateAllLabTests.js --global-only --apply --confirm=${CONFIRMATION}
  node scripts/deactivateAllLabTests.js --templates-only --apply --confirm=${CONFIRMATION}

Audit an exported MongoDB JSON array without connecting:
  node scripts/deactivateAllLabTests.js --export=/path/test.labtests.json

Optional report:
  --report=/path/deactivation-audit.json

The command is a dry run unless both --apply and the confirmation value are supplied.
`);
}

function mongoValue(value) {
  if (value && typeof value === 'object' && '$oid' in value) return value.$oid;
  return value;
}

function readExport(exportPath) {
  const resolved = path.resolve(exportPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('The export must contain a JSON array');
  return parsed.map((item) => ({
    ...item,
    _id: mongoValue(item._id),
    hospitalId: mongoValue(item.hospitalId)
  }));
}

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

function buildReport(tests, options) {
  const activeTests = tests.filter((test) => test.is_active === true);
  return {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'APPLY' : 'DRY_RUN',
    selectedTests: tests.length,
    currentlyActive: activeTests.length,
    alreadyInactive: tests.length - activeTests.length,
    testsToDeactivate: activeTests.length,
    activeTests: activeTests.map((test) => ({
      id: String(test._id),
      hospitalId: test.hospitalId ? String(test.hospitalId) : null,
      code: test.code || '',
      name: test.name || '',
      basePrice: Number(test.base_price || 0),
      reportTemplateId: test.report_template_id || null
    }))
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
  console.log('\nLab-test deactivation audit');
  console.log('---------------------------');
  console.log(`Mode:                ${report.mode}`);
  console.log(`Selected tests:      ${report.selectedTests}`);
  console.log(`Currently active:    ${report.currentlyActive}`);
  console.log(`Already inactive:    ${report.alreadyInactive}`);
  console.log(`Tests to deactivate: ${report.testsToDeactivate}`);

  if (report.activeTests.length) {
    console.log('\nFirst active tests to be deactivated:');
    for (const item of report.activeTests.slice(0, 20)) {
      console.log(`  ${item.code.padEnd(14)} ${item.name}`);
    }
    if (report.activeTests.length > 20) console.log('  ...');
  }
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
  if (options.apply && options.confirmation !== CONFIRMATION) {
    throw new Error(`Applying deactivation requires --confirm=${CONFIRMATION}`);
  }

  let connected = false;
  let mongoose;
  let LabTest;
  try {
    let tests;
    if (options.exportPath) {
      tests = readExport(options.exportPath).filter((test) => exportedTestInScope(test, options));
    } else {
      if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required when --export is not supplied');
      const dependencies = loadDatabaseDependencies();
      mongoose = dependencies.mongoose;
      LabTest = dependencies.LabTest;
      await dependencies.connectDB();
      connected = true;
      tests = await LabTest.find(scopeFilter(options, mongoose))
        .select('_id hospitalId code name category base_price is_active report_template_id')
        .lean();
    }

    const report = buildReport(tests, options);
    printSummary(report);
    writeReport(options.reportPath, report);

    if (!options.apply) {
      console.log(`\nDry run only. To proceed, add --apply --confirm=${CONFIRMATION}`);
      return;
    }

    const filter = { ...scopeFilter(options, mongoose), is_active: true };
    const result = await LabTest.updateMany(filter, {
      $set: { is_active: false, updatedAt: new Date() }
    });

    console.log('\nDeactivation completed:');
    console.log(`  matched:  ${result.matchedCount || 0}`);
    console.log(`  modified: ${result.modifiedCount || 0}`);
    console.log('  Prices and report-template links were preserved.');
  } finally {
    if (connected && mongoose) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nLab-test deactivation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION,
  buildReport,
  parseArgs,
  scopeFilter
};
