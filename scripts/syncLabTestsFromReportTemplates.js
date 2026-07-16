#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('../config/db');
const LabTest = require('../models/LabTest');
const catalog = require('../data/labReportTemplates.json');
const {
  catalogVersion,
  matchTemplateDetailed,
  normalizeLabTestName
} = require('../services/labReportTemplate.service');

function parseArgs(argv) {
  return argv.reduce((options, argument) => {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--hospital=')) options.hospitalId = argument.slice('--hospital='.length);
    else if (argument.startsWith('--export=')) options.exportPath = argument.slice('--export='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else if (argument.startsWith('--price=')) options.basePrice = Number(argument.slice('--price='.length));
    else if (argument.startsWith('--turnaround=')) options.turnaround = Number(argument.slice('--turnaround='.length));
    return options;
  }, {
    apply: false,
    hospitalId: '',
    exportPath: '',
    reportPath: '',
    basePrice: 0,
    turnaround: 24
  });
}

function printHelp() {
  console.log(`
Audit and add LabTest master rows for the 105 structured report templates.

Dry-run against MongoDB:
  node scripts/syncLabTestsFromReportTemplates.js

Apply inserts and template links:
  node scripts/syncLabTestsFromReportTemplates.js --apply

Hospital-specific master data:
  node scripts/syncLabTestsFromReportTemplates.js --hospital=<hospitalObjectId> --apply

Audit a MongoDB JSON export without connecting to MongoDB:
  node scripts/syncLabTestsFromReportTemplates.js --export=/path/to/test.labtests.json

Options:
  --report=/path/audit.json   Write the complete audit result to JSON
  --price=0                  Default price for newly inserted tests
  --turnaround=24            Default turnaround hours for newly inserted tests
`);
}

function readExport(exportPath) {
  const resolved = path.resolve(exportPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('The export must contain a JSON array of lab tests');
  return parsed.map((item) => ({
    ...item,
    _id: item?._id?.$oid || item?._id,
    hospitalId: item?.hospitalId?.$oid || item?.hospitalId
  }));
}

function inferCategory(template) {
  const name = template.name.toLowerCase();
  if (/cbc|blood count|leucocyte|lymphocyte|monocyte|basophil|eosinophil|polymorph|hemoglobin|haemoglobin|hematocrit|packed cell|platelet|reticulocyte|mch|mcv|esr|coagulation|fibrinogen|peripheral blood smear/.test(name)) return 'Hematology';
  if (/culture|sars|covid|pcr|gonorrhoeae/.test(name)) return 'Microbiology';
  if (/antibod|hiv|dengue|torch|vdrl|rpr|widal|typhidot|rast|immunoglobulin/.test(name)) return 'Immunology';
  if (/cytology|pap smear|semen analysis/.test(name)) return 'Pathology';
  if (/hcg|cortisone|c-peptide|follicle stimulating|luteinising|progesterone|prolactin|testosterone|thyroid|thyroxine|triiodothyronine|calcitonin/.test(name)) return 'Endocrinology';
  if (/bone mineral density|karyotype|her2/.test(name)) return 'Other';
  return 'Biochemistry';
}

function inferSpecimenType(template) {
  const specimen = String(template.specimen || '').toLowerCase();
  if (specimen.includes('urine')) return 'Urine';
  if (specimen.includes('stool') || specimen.includes('fecal')) return 'Stool';
  if (specimen.includes('csf') || specimen.includes('cerebrospinal')) return 'CSF';
  if (specimen.includes('sputum')) return 'Sputum';
  if (specimen.includes('tissue') || specimen.includes('ffpe')) return 'Tissue';
  if (specimen.includes('swab')) return 'Swab';
  if (specimen.includes('blood') || specimen.includes('serum') || specimen.includes('plasma')) return 'Blood';
  return 'Other';
}

function seedCode(template) {
  return `LT-RPT-${String(template.number).padStart(3, '0')}`;
}

function templateSeedDocument(template, options) {
  const observations = template.observations || [];
  const singleObservation = observations.length === 1 ? observations[0] : null;
  return {
    ...(options.hospitalId ? { hospitalId: new mongoose.Types.ObjectId(options.hospitalId) } : {}),
    code: seedCode(template),
    name: template.name,
    category: inferCategory(template),
    subCategory: 'Structured Report Template',
    description: [
      template.templateNotes,
      `Structured laboratory report template ${template.number} of 105.`
    ].filter(Boolean).join(' '),
    specimen_type: inferSpecimenType(template),
    turnaround_time_hours: Number.isFinite(options.turnaround) ? options.turnaround : 24,
    normal_range: singleObservation?.referenceText || (observations.length > 1 ? 'See structured report template' : ''),
    units: singleObservation?.unit || '',
    base_price: Number.isFinite(options.basePrice) ? options.basePrice : 0,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0,
    report_template_id: template.id,
    report_template_name: template.name,
    report_template_version: catalogVersion
  };
}

function auditTests(tests) {
  const assignments = new Map();
  const unmatchedTests = [];
  const possibleMatches = [];

  for (const test of tests) {
    const storedTemplateId = test.report_template_id || test.reportTemplateId || '';
    const match = matchTemplateDetailed(test.name || '', test.code || '', storedTemplateId);
    if (!match) {
      unmatchedTests.push({ id: test._id, code: test.code, name: test.name });
      continue;
    }

    // Database seeding is deliberately conservative. Only explicit aliases/canonical names
    // or a previously stored template ID count as an existing template-backed test.
    const isConfirmed = match.score >= 900 || match.matchedOn === 'stored-template-id';
    if (!isConfirmed) {
      possibleMatches.push({
        id: test._id,
        code: test.code,
        name: test.name,
        suggestedTemplateId: match.template.id,
        suggestedTemplateName: match.template.name,
        score: match.score
      });
      unmatchedTests.push({ id: test._id, code: test.code, name: test.name });
      continue;
    }

    if (!assignments.has(match.template.id)) assignments.set(match.template.id, []);
    assignments.get(match.template.id).push({
      id: test._id,
      code: test.code,
      name: test.name,
      currentTemplateId: storedTemplateId || null,
      templateId: match.template.id,
      templateName: match.template.name,
      score: match.score
    });
  }

  const presentTemplates = catalog.templates
    .filter((template) => assignments.has(template.id))
    .map((template) => ({
      templateId: template.id,
      number: template.number,
      templateName: template.name,
      matches: assignments.get(template.id)
    }));

  const missingTemplates = catalog.templates
    .filter((template) => !assignments.has(template.id))
    .map((template) => ({
      templateId: template.id,
      number: template.number,
      code: seedCode(template),
      name: template.name,
      category: inferCategory(template),
      specimen_type: inferSpecimenType(template)
    }));

  return {
    generatedAt: new Date().toISOString(),
    catalogVersion,
    databaseTestCount: tests.length,
    activeTestCount: tests.filter((test) => test.is_active === true).length,
    inactiveTestCount: tests.filter((test) => test.is_active === false).length,
    templateCount: catalog.templates.length,
    presentTemplateCount: presentTemplates.length,
    missingTemplateCount: missingTemplates.length,
    presentTemplates,
    missingTemplates,
    possibleMatches,
    unmatchedDatabaseTests: unmatchedTests
  };
}

async function applyAudit(audit, tests, options) {
  const operations = [];
  const testById = new Map(tests.map((test) => [String(test._id), test]));

  for (const present of audit.presentTemplates) {
    for (const match of present.matches) {
      if (!match.id || !testById.has(String(match.id))) continue;
      operations.push({
        updateOne: {
          filter: { _id: match.id },
          update: {
            $set: {
              report_template_id: present.templateId,
              report_template_name: present.templateName,
              report_template_version: catalogVersion
            }
          }
        }
      });
    }
  }

  for (const missing of audit.missingTemplates) {
    const template = catalog.templates.find((item) => item.id === missing.templateId);
    const document = templateSeedDocument(template, options);
    const hospitalScope = options.hospitalId
      ? { hospitalId: new mongoose.Types.ObjectId(options.hospitalId) }
      : { hospitalId: null };

    operations.push({
      updateOne: {
        filter: { ...hospitalScope, report_template_id: template.id },
        update: { $setOnInsert: document },
        upsert: true
      }
    });
  }

  if (!operations.length) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  return LabTest.bulkWrite(operations, { ordered: false });
}

function writeReport(audit, reportPath) {
  if (!reportPath) return;
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(`Audit report written to ${resolved}`);
}

function printSummary(audit, options) {
  console.log('\nLaboratory test/template audit');
  console.log('--------------------------------');
  console.log(`Lab tests found:             ${audit.databaseTestCount}`);
  console.log(`Active / inactive:           ${audit.activeTestCount} / ${audit.inactiveTestCount}`);
  console.log(`Structured templates:        ${audit.templateCount}`);
  console.log(`Templates already represented: ${audit.presentTemplateCount}`);
  console.log(`Templates missing:           ${audit.missingTemplateCount}`);
  console.log(`Mode:                        ${options.apply ? 'APPLY' : 'DRY RUN'}`);

  if (audit.missingTemplates.length) {
    console.log('\nMissing template-backed tests:');
    for (const item of audit.missingTemplates) {
      console.log(`  ${String(item.number).padStart(3, '0')}  ${item.code}  ${item.name}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.hospitalId && !mongoose.isValidObjectId(options.hospitalId)) {
    throw new Error('--hospital must be a valid MongoDB ObjectId');
  }

  let tests;
  let connected = false;
  try {
    if (options.exportPath) {
      tests = readExport(options.exportPath);
      if (options.apply) throw new Error('--apply cannot be used with --export; connect to MongoDB to write changes');
    } else {
      if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required when --export is not supplied');
      await connectDB();
      connected = true;
      const filter = options.hospitalId
        ? { hospitalId: new mongoose.Types.ObjectId(options.hospitalId) }
        : { $or: [{ hospitalId: null }, { hospitalId: { $exists: false } }] };
      tests = await LabTest.find(filter).lean();
    }

    const audit = auditTests(tests);
    printSummary(audit, options);
    writeReport(audit, options.reportPath);

    if (options.apply) {
      const result = await applyAudit(audit, tests, options);
      console.log('\nDatabase synchronization complete:');
      console.log(`  matched:  ${result.matchedCount || 0}`);
      console.log(`  modified: ${result.modifiedCount || 0}`);
      console.log(`  inserted: ${result.upsertedCount || 0}`);
    } else {
      console.log('\nDry run only. Add --apply to insert missing tests and link existing tests.');
    }
  } finally {
    if (connected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\nLab test synchronization failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditTests,
  inferCategory,
  inferSpecimenType,
  seedCode,
  templateSeedDocument
};
