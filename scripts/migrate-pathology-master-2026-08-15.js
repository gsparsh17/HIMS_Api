#!/usr/bin/env node
'use strict';

const LabTest = require('../models/LabTest');
const {
  catalogVersion,
  getTemplate,
  matchTemplate
} = require('../services/labReportTemplate.service');
const {
  migrationOptions,
  loadMaster,
  normalize,
  escapeRegex,
  writeState,
  connect,
  close,
  baseReport
} = require('./lib/hmsMigrationUtils');

function category(mainService) {
  const value = normalize(mainService);
  if (value.includes('haemat') || value.includes('hemat')) return 'Hematology';
  if (value.includes('biochem')) return 'Biochemistry';
  if (value.includes('micro') || value.includes('bacter')) return 'Microbiology';
  if (value.includes('serolog')) return 'Serology';
  if (value.includes('immun')) return 'Immunology';
  if (value.includes('histo') || value.includes('biops') || value.includes('urine') || value.includes('urology')) return 'Pathology';
  return 'Other';
}

function specimenType(value) {
  const text = normalize(value);
  if (!text) return 'Other';
  if (text.includes('blood') || text.includes('serum') || text.includes('plasma')) return 'Blood';
  if (text.includes('urine')) return 'Urine';
  if (text.includes('stool') || text.includes('fecal') || text.includes('faecal')) return 'Stool';
  if (text.includes('csf')) return 'CSF';
  if (text.includes('sputum')) return 'Sputum';
  if (text.includes('swab')) return 'Swab';
  if (text.includes('semen')) return 'Semen';
  if (text.includes('fluid')) return 'Body Fluid';
  if (text.includes('tissue') || text.includes('biopsy') || text.includes('aspirate') || text.includes('smear')) return 'Tissue';
  return 'Other';
}

function parametersFromTemplate(template) {
  if (!template?.observations?.length) return [];
  return template.observations.map((observation, index) => ({
    code: `P${String(index + 1).padStart(3, '0')}`,
    name: String(observation.name || `Parameter ${index + 1}`).trim(),
    resultType: ['numeric', 'text', 'boolean'].includes(observation.resultType) ? observation.resultType : 'text',
    unit: String(observation.unit || '').trim(),
    referenceText: String(observation.referenceText || '').trim(),
    sortOrder: index,
    active: true
  }));
}

function templateFor(test) {
  if (test?.report_template_id) {
    const stored = getTemplate(test.report_template_id);
    if (stored) return stored;
  }
  return matchTemplate(test?.name || '', test?.code || '', test?.report_template_id || '');
}

function sourceTemplate(name, code = '') {
  return matchTemplate(name, code);
}

async function run() {
  const opts = migrationOptions();
  const master = loadMaster('data/masters/pathology-test-master-2026-08-15.json');
  const report = baseReport('pathology-test-master-2026-08-15', opts.apply, opts.hospitalId);
  report.templateParametersAdded = 0;
  report.templateMatched = 0;
  report.templateUnmatched = 0;
  report.notes = [
    'The supplied department-wise workbook contains test/service names and prices, but not parameter/reference-range definitions.',
    'Where a high-confidence existing MediQliq lab report template matches, its structured observations are materialised into LabTest.parameters. Existing manually configured parameters are preserved.'
  ];

  const seenNaturalKeys = new Set();
  await connect();
  try {
    for (const source of master.records) {
      const name = String(source.serviceName || '').trim();
      const amount = Number(source.amount || 0);
      if (!name || !Number.isFinite(amount) || amount < 0) {
        report.skipped += 1;
        continue;
      }
      const naturalKey = `${normalize(source.mainService)}|${normalize(name)}|${amount}`;
      if (seenNaturalKeys.has(naturalKey)) {
        report.skipped += 1;
        report.changes.push({ action: 'skip-duplicate-source-row', serialNumber: source.serialNumber, name, amount });
        continue;
      }
      seenNaturalKeys.add(naturalKey);

      let existing = await LabTest.findOne({
        hospitalId: opts.hospitalId,
        'masterSource.key': 'pathology-test-master-2026-08-15',
        'masterSource.serialNumber': source.serialNumber
      });
      if (!existing) {
        existing = await LabTest.findOne({
          hospitalId: opts.hospitalId,
          name: new RegExp(`^${escapeRegex(name)}$`, 'i')
        });
      }

      const sourceCode = existing?.code || `LT-SRC-${String(source.serialNumber).padStart(4, '0')}`;
      const template = existing ? templateFor(existing) : sourceTemplate(name, sourceCode);
      if (template) report.templateMatched += 1;
      else report.templateUnmatched += 1;
      const templateParameters = parametersFromTemplate(template);

      if (!existing) {
        report.inserted += 1;
        report.changes.push({
          action: 'insert',
          serialNumber: source.serialNumber,
          name,
          amount,
          templateId: template?.id || null,
          parameterCount: templateParameters.length
        });

        if (templateParameters.length) report.templateParametersAdded += templateParameters.length;

        if (opts.apply) {
          await LabTest.create({
            hospitalId: opts.hospitalId,
            code: sourceCode,
            name,
            main_service: source.mainService,
            category: category(source.mainService),
            specimen_type: specimenType(template?.specimen),
            specimen_detail: template?.specimen || '',
            base_price: amount,
            is_active: true,
            is_billable: true,
            allow_zero_price: amount === 0,
            report_template_id: template?.id,
            report_template_name: template?.name,
            report_template_version: template ? catalogVersion : undefined,
            parameters: templateParameters,
            masterSource: {
              key: 'pathology-test-master-2026-08-15',
              version: master.source.importVersion,
              serialNumber: source.serialNumber,
              checksum: master.source.sha256,
              importedAt: new Date()
            }
          });
        }
        continue;
      }

      const oldPrice = Number(existing.base_price || 0);
      const needsParameters = (!Array.isArray(existing.parameters) || existing.parameters.length === 0) && templateParameters.length > 0;
      const needsTemplate = Boolean(template) && existing.report_template_id !== template.id;
      const changed = oldPrice !== amount
        || normalize(existing.main_service) !== normalize(source.mainService)
        || existing.masterSource?.checksum !== master.source.sha256
        || needsParameters
        || needsTemplate;

      if (!changed) {
        report.unchanged += 1;
        continue;
      }

      report.updated += 1;
      report.changes.push({
        action: 'update',
        id: existing._id,
        name,
        oldPrice,
        newPrice: amount,
        templateId: template?.id || existing.report_template_id || null,
        parametersAdded: needsParameters ? templateParameters.length : 0
      });
      if (needsParameters) report.templateParametersAdded += templateParameters.length;

      if (opts.apply) {
        if (oldPrice !== amount) {
          existing.priceHistory.push({
            amount: oldPrice,
            effectiveFrom: existing.updatedAt || existing.createdAt || new Date(),
            effectiveTo: new Date(),
            reason: `Reconciled to ${master.source.filename}`
          });
        }
        existing.base_price = amount;
        existing.main_service = source.mainService;
        existing.category = category(source.mainService);
        existing.allow_zero_price = amount === 0;
        if (template) {
          existing.report_template_id = template.id;
          existing.report_template_name = template.name;
          existing.report_template_version = catalogVersion;
          if (!existing.specimen_detail) existing.specimen_detail = template.specimen || '';
          if (!existing.specimen_type || existing.specimen_type === 'Other') {
            existing.specimen_type = specimenType(template.specimen);
          }
          if (needsParameters) existing.parameters = templateParameters;
        }
        existing.masterSource = {
          key: 'pathology-test-master-2026-08-15',
          version: master.source.importVersion,
          serialNumber: source.serialNumber,
          checksum: master.source.sha256,
          importedAt: new Date()
        };
        await existing.save();
      }
    }
  } finally {
    await close();
  }

  const state = writeState(report, opts.statePath);
  console.log(JSON.stringify({ ...report, state }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
