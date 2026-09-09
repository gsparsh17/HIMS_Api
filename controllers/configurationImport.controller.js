const crypto = require('crypto');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const BulkImportJob = require('../models/BulkImportJob');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const { requireHospitalId } = require('../services/tenantScope.service');
const { reviewMapping } = require('../services/tariffMapping.service');
const { validateRateCard } = require('../services/tariffValidation.service');

const ENTITIES = {
  payers: {
    title: 'Insurance Provider / Payer Master',
    sheet: 'Payers',
    columns: [
      ['code', true], ['name', true], ['type', true], ['network_status', false], ['empanelment_status', false],
      ['empanelment_number', false], ['empanelment_valid_from', false], ['empanelment_valid_to', false],
      ['credit_days', false], ['claim_submission_days', false], ['missing_item_policy', false],
      ['balance_billing_policy', false], ['default_copay_percentage', false], ['default_deductible_amount', false],
      ['demo_only', false], ['is_active', false]
    ],
    example: { code: 'TPA01', name: 'Example TPA', type: 'tpa', network_status: 'network', empanelment_status: 'active', credit_days: 30, claim_submission_days: 7, missing_item_policy: 'cash_fallback', balance_billing_policy: 'patient', demo_only: false, is_active: true }
  },
  'rate-cards': {
    title: 'Payer Rate Cards', sheet: 'Rate Cards',
    columns: [['payer_code', true], ['name', true], ['version', true], ['effective_from', true], ['effective_to', false], ['currency', false], ['demo_only', false], ['missing_item_policy', false], ['require_all_mappings', false], ['minimum_mapping_percentage', false], ['require_source_verification', false], ['source_title', false], ['source_filename', false], ['source_issue_date', false], ['source_checksum', false]],
    example: { payer_code: 'TPA01', name: 'Example Tariff 2026', version: 'TPA01-2026-v1', effective_from: '2026-08-01', currency: 'INR', missing_item_policy: 'cash_fallback', minimum_mapping_percentage: 80, source_title: 'Signed tariff agreement' }
  },
  'rate-card-items': {
    title: 'Rate Card Packages / Items', sheet: 'Rate Card Items',
    columns: [
      ['payer_code', true], ['rate_card_version', true], ['external_code', true], ['external_name', true], ['service_type', true], ['specialty', false], ['category', false], ['pricing_mode', false],
      ['flat_amount', false], ['tier_i_non_nabh', false], ['tier_i_nabh', false], ['tier_i_super_speciality', false], ['tier_ii_non_nabh', false], ['tier_ii_nabh', false], ['tier_ii_super_speciality', false], ['tier_iii_non_nabh', false], ['tier_iii_nabh', false], ['tier_iii_super_speciality', false],
      ['ward_general', false], ['ward_semi_private', false], ['ward_private', false], ['ward_icu', false], ['ward_day_care', false], ['package_period_days', false], ['is_package', false], ['includes_medicines', false], ['includes_consumables', false], ['includes_investigations', false], ['includes_room', false], ['includes_professional_fees', false], ['default_unlisted_treatment', false], ['inclusions_json', false], ['exclusions_json', false], ['allowed_wards', false], ['patient_share_mode', false], ['patient_share_percentage', false], ['patient_share_fixed', false], ['sponsor_cap', false], ['preauth_required', false], ['source_page', false], ['source_sheet', false], ['source_annexure', false], ['source_serial_number', false], ['required_for_billing', false], ['active', false]
    ],
    example: { payer_code: 'TPA01', rate_card_version: 'TPA01-2026-v1', external_code: 'PKG-GS-001', external_name: 'Laparoscopic Appendicectomy', service_type: 'procedure', category: 'General Surgery', pricing_mode: 'exact_ward', ward_general: 30000, ward_semi_private: 34000, ward_private: 40000, package_period_days: 7, is_package: true, includes_medicines: true, default_unlisted_treatment: 'included', source_page: 1 }
  },
  'rate-card-mappings': {
    title: 'Rate Card to Hospital Service Mapping Suggestions', sheet: 'Mappings',
    columns: [['payer_code', true], ['rate_card_version', true], ['external_code', true], ['internal_model', true], ['internal_code', true], ['confidence', false], ['rationale', false], ['allow_multiple_external_codes', false], ['required_for_billing', false]],
    example: { payer_code: 'TPA01', rate_card_version: 'TPA01-2026-v1', external_code: 'PKG-GS-001', internal_model: 'Procedure', internal_code: 'GS001', confidence: 1, rationale: 'Reviewed against signed agreement', allow_multiple_external_codes: false }
   }

};

const DEPRECATED_SERVICE_IMPORTS = {
  'service-procedures': { label: 'Procedure master', coreEntity: 'procedures', uiRoute: '/dashboard/admin/ot/procedures', apiBase: '/api/procedures' },
  'service-lab-tests': { label: 'Laboratory test master', coreEntity: 'lab-tests', uiRoute: '/dashboard/admin/lab-tests', apiBase: '/api/labtests' },
  'service-imaging-tests': { label: 'Imaging test master', coreEntity: 'radiology-tests', uiRoute: '/dashboard/admin/imaging-tests', apiBase: '/api/radiology/tests' }
};

function deprecatedServiceImport(res, entity) {
  const target = DEPRECATED_SERVICE_IMPORTS[entity];
  if (!target) return false;
  res.status(410).json({
    success: false,
    code: 'SERVICE_MASTER_IMPORT_MOVED',
    error: `${target.label} bulk import is managed only from its core hospital module. The duplicate insurance/configuration import path has been retired.`,
    canonicalImportEntity: target.coreEntity,
    canonicalTemplateEndpoint: `/api/imports/templates/${target.coreEntity}`,
    canonicalPreviewEndpoint: `/api/imports/${target.coreEntity}/preview`,
    canonicalManagementApi: target.apiBase,
    canonicalUiRoute: target.uiRoute
  });
  return true;
}

function assertContractPayer(payer) {
  if (String(payer?.type || '').toLowerCase() !== 'self') return;
  const error = new Error('SELF/cash does not use a contracted rate card. Hospital master prices are the authoritative SELF prices.');
  error.statusCode = 422;
  throw error;
}

const bool = (value, fallback = false) => value === undefined || value === null || value === '' ? fallback : ['true', 'yes', '1', 'y'].includes(String(value).trim().toLowerCase());
const number = (value) => value === undefined || value === null || value === '' ? undefined : Number(String(value).replaceAll(',', ''));
const date = (value) => { if (!value) return undefined; const parsed = value instanceof Date ? value : new Date(value); return Number.isNaN(parsed.getTime()) ? undefined : parsed; };
const list = (value) => String(value || '').split(',').map((row) => row.trim()).filter(Boolean);
function json(value, fallback = []) { if (!value) return fallback; try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed; } catch { return null; } }
function trim(value) { return String(value ?? '').trim(); }
function fail(res, error) { res.status(error.statusCode || 400).json({ success: false, error: error.message }); }

async function parseFile(file) {
  const workbook = new ExcelJS.Workbook();
  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  if (!['xlsx', 'csv'].includes(ext)) {
    const error = new Error('Only .xlsx and .csv files are supported. Legacy .xls files must be re-saved as .xlsx.');
    error.statusCode = 415;
    throw error;
  }
  try {
    if (ext === 'csv') await workbook.csv.read(Readable.from(file.buffer));
    else await workbook.xlsx.load(file.buffer);
  } catch (cause) {
    const error = new Error(`Unable to read ${ext.toUpperCase()} file. Re-save the workbook as a standard .xlsx file and retry. Parser detail: ${cause.message}`);
    error.statusCode = 422;
    throw error;
  }
  const sheet = workbook.worksheets.find((row) => row.name !== 'Instructions') || workbook.worksheets[0];
  if (!sheet) throw new Error('No data sheet found');
  const headers = [];
  sheet.getRow(1).eachCell((cell, column) => { headers[column - 1] = trim(cell.value); });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {}; let hasData = false;
    headers.forEach((header, index) => {
      if (!header) return;
      const raw = row.getCell(index + 1).value;
      const value = raw?.text ?? raw?.result ?? raw ?? '';
      data[header] = typeof value === 'string' ? value.trim() : value;
      if (data[header] !== '') hasData = true;
    });
    if (hasData) rows.push({ rowNumber, data });
  });
  return { headers, rows };
}

function normalize(entity, row, hospitalId, userId) {
  if (entity === 'payers') return {
    hospitalId, code: trim(row.code).toUpperCase(), name: trim(row.name), type: trim(row.type), networkStatus: trim(row.network_status) || 'not_applicable', demoOnly: bool(row.demo_only), isActive: bool(row.is_active, true),
    empanelment: { status: trim(row.empanelment_status) || 'pending', number: trim(row.empanelment_number), effectiveFrom: date(row.empanelment_valid_from), effectiveTo: date(row.empanelment_valid_to) },
    settlementTerms: { creditDays: number(row.credit_days) ?? 30, claimSubmissionDays: number(row.claim_submission_days) ?? 7 },
    pricingPolicy: { missingItem: trim(row.missing_item_policy) || 'cash_fallback', balanceBilling: trim(row.balance_billing_policy) || 'patient', defaultCoPayPercentage: number(row.default_copay_percentage) ?? 0, defaultDeductibleAmount: number(row.default_deductible_amount) ?? 0 },
    createdBy: userId, updatedBy: userId
  };
  if (entity === 'rate-cards') return {
    hospitalId, _payerCode: trim(row.payer_code).toUpperCase(), name: trim(row.name), version: trim(row.version), effectiveFrom: date(row.effective_from), effectiveTo: date(row.effective_to), currency: trim(row.currency) || 'INR', status: 'staging', demoOnly: bool(row.demo_only),
    rules: { missingItemPolicy: trim(row.missing_item_policy) || 'inherit_payer' },
    activationRequirements: { requireAllBillableMappings: bool(row.require_all_mappings), minimumApprovedMappingPercentage: number(row.minimum_mapping_percentage) ?? 0, requireSourceVerification: bool(row.require_source_verification) },
    source: { title: trim(row.source_title), filename: trim(row.source_filename), issueDate: date(row.source_issue_date), checksum: trim(row.source_checksum), uploadedBy: userId, uploadedAt: new Date() }, createdBy: userId, updatedBy: userId
  };
  if (entity === 'rate-card-items') return {
    hospitalId, _payerCode: trim(row.payer_code).toUpperCase(), _rateCardVersion: trim(row.rate_card_version), externalCode: trim(row.external_code).toUpperCase(), externalName: trim(row.external_name), serviceType: trim(row.service_type), specialty: trim(row.specialty), category: trim(row.category), pricingMode: trim(row.pricing_mode) || (bool(row.is_package) ? 'package' : 'matrix'),
    rates: { tierI: { nonNabh: number(row.tier_i_non_nabh), nabh: number(row.tier_i_nabh), superSpeciality: number(row.tier_i_super_speciality) }, tierII: { nonNabh: number(row.tier_ii_non_nabh), nabh: number(row.tier_ii_nabh), superSpeciality: number(row.tier_ii_super_speciality) }, tierIII: { nonNabh: number(row.tier_iii_non_nabh), nabh: number(row.tier_iii_nabh), superSpeciality: number(row.tier_iii_super_speciality) }, flatAmount: number(row.flat_amount), exactWard: { general: number(row.ward_general), semiPrivate: number(row.ward_semi_private), private: number(row.ward_private), icu: number(row.ward_icu), dayCare: number(row.ward_day_care) } },
    patientShare: { mode: trim(row.patient_share_mode) || 'coverage_default', percentage: number(row.patient_share_percentage), fixedAmount: number(row.patient_share_fixed), sponsorCap: number(row.sponsor_cap) },
    packagePeriodDays: number(row.package_period_days), packageDefinition: { isPackage: bool(row.is_package), includesMedicines: bool(row.includes_medicines), includesConsumables: bool(row.includes_consumables), includesInvestigations: bool(row.includes_investigations), includesRoom: bool(row.includes_room), includesProfessionalFees: bool(row.includes_professional_fees), defaultUnlistedComponentTreatment: trim(row.default_unlisted_treatment) || 'excluded', inclusions: json(row.inclusions_json, []), exclusions: json(row.exclusions_json, []) },
    allowedWards: list(row.allowed_wards), claimRules: { preAuthorisationRequired: bool(row.preauth_required) }, sourceRow: { page: number(row.source_page), sheet: trim(row.source_sheet), annexure: trim(row.source_annexure), serialNumber: number(row.source_serial_number), raw: row }, active: bool(row.active, true), internalService: { mappingStatus: 'unmapped' }, mappingOptions: { requiredForBilling: bool(row.required_for_billing, true), unavailableAtHospital: false, allowMultipleExternalCodes: false }
  };
  if (entity === 'rate-card-mappings') return { hospitalId, _payerCode: trim(row.payer_code).toUpperCase(), _rateCardVersion: trim(row.rate_card_version), externalCode: trim(row.external_code).toUpperCase(), internalModel: trim(row.internal_model), internalCode: trim(row.internal_code).toUpperCase(), confidence: number(row.confidence), rationale: trim(row.rationale), allowMultipleExternalCodes: bool(row.allow_multiple_external_codes), requiredForBilling: bool(row.required_for_billing, true) };
  throw new Error('Unsupported configuration import entity');
}

function validate(entity, data) {
  const errors = [];
  const required = ENTITIES[entity].columns.filter((row) => row[1]).map((row) => row[0]);
  const mapping = { payer_code: '_payerCode', rate_card_version: '_rateCardVersion', external_code: 'externalCode', external_name: 'externalName', service_type: 'serviceType', internal_model: 'internalModel', internal_code: 'internalCode', effective_from: 'effectiveFrom', source_page: 'sourceRow.page' };
  function value(path) { return path.split('.').reduce((current, key) => current?.[key], data); }
  required.forEach((column) => { const key = mapping[column] || column; if (value(key) === undefined || value(key) === null || value(key) === '') errors.push(`${column} is required`); });
  if ('base_price' in data && (!Number.isFinite(Number(data.base_price)) || Number(data.base_price) < 0)) errors.push('base_price must be a non-negative number');
  if (entity === 'payers') {
    if (!['self', 'pmjay', 'cghs', 'state_scheme', 'echs', 'esic', 'government_other', 'corporate', 'private_insurer', 'tpa', 'other'].includes(data.type)) errors.push('type is invalid');
    if (!['network', 'non_network', 'not_applicable'].includes(data.networkStatus)) errors.push('network_status is invalid');
  }
  if (entity === 'rate-card-items') {
    if (data.packageDefinition.inclusions === null) errors.push('inclusions_json must be valid JSON');
    if (data.packageDefinition.exclusions === null) errors.push('exclusions_json must be valid JSON');
    if (!data.sourceRow?.page && !data.sourceRow?.sheet && !data.sourceRow?.annexure) errors.push('source_page, source_sheet or source_annexure is required');
  }
  return errors;
}

async function resolveReferences(entity, data, hospitalId) {
  if (entity === 'rate-cards') {
    const payer = await Payer.findOne({ hospitalId, code: data._payerCode });
    if (!payer) throw new Error(`Payer ${data._payerCode} not found`);
    assertContractPayer(payer);
    data.payerId = payer._id; delete data._payerCode;
  }
  if (['rate-card-items', 'rate-card-mappings'].includes(entity)) {
    const payer = await Payer.findOne({ hospitalId, code: data._payerCode });
    if (!payer) throw new Error(`Payer ${data._payerCode} not found`);
    assertContractPayer(payer);
    const card = await RateCard.findOne({ hospitalId, payerId: payer._id, version: data._rateCardVersion });
    if (!card) throw new Error(`Rate card ${data._rateCardVersion} for ${data._payerCode} not found`);
    data.payerId = payer._id; data.rateCardId = card._id; delete data._payerCode; delete data._rateCardVersion;
  }
  return data;
}

async function existing(entity, data, hospitalId) {
  if (entity === 'payers') return Payer.findOne({ hospitalId, code: data.code });
  if (entity === 'rate-cards') return RateCard.findOne({ hospitalId, payerId: data.payerId, version: data.version });
  if (entity === 'rate-card-items') return RateCardItem.findOne({ hospitalId, rateCardId: data.rateCardId, externalCode: data.externalCode });
  if (entity === 'rate-card-mappings') return RateCardItem.findOne({ hospitalId, rateCardId: data.rateCardId, externalCode: data.externalCode });
  return null;
}

function natural(entity, data) {
  if (entity === 'payers') return data.code;
  if (entity === 'rate-cards') return `${data.payerId}|${data.version}`;
  if (['rate-card-items', 'rate-card-mappings'].includes(entity)) return `${data.rateCardId}|${data.externalCode}`;
  return data.code;
}

function model(entity) {
  return { payers: Payer, 'rate-cards': RateCard, 'rate-card-items': RateCardItem }[entity];
}

exports.template = async (req, res) => {
  try {
    if (deprecatedServiceImport(res, req.params.entity)) return;
    const meta = ENTITIES[req.params.entity];
    if (!meta) return res.status(404).json({ success: false, error: 'Unknown import entity' });
    const workbook = new ExcelJS.Workbook();
    const instructions = workbook.addWorksheet('Instructions');
    instructions.addRow([meta.title]); instructions.addRow(['Use preview before commit. Hospital scope is derived from the authenticated user and must not be uploaded.']); instructions.addRow(['Rate-card mappings are imported only as suggestions and require separate human approval.']);
    const sheet = workbook.addWorksheet(meta.sheet);
    sheet.addRow(meta.columns.map((row) => row[0]));
    sheet.addRow(meta.columns.map((row) => meta.example[row[0]] ?? ''));
    sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.columns.forEach((column) => { column.width = 24; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-template.xlsx"`); await workbook.xlsx.write(res); res.end();
  } catch (error) { fail(res, error); }
};

exports.preview = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entity = req.params.entity;
    if (deprecatedServiceImport(res, entity)) return;
    if (!ENTITIES[entity]) return res.status(404).json({ success: false, error: 'Unknown import entity' });
    if (!req.file) return res.status(422).json({ success: false, error: 'file is required' });
    const ext = String(req.file.originalname || '').split('.').pop().toLowerCase();
    if (!['xlsx', 'csv'].includes(ext)) return res.status(422).json({ success: false, error: 'Only .xlsx or .csv files are supported' });
    const mode = req.body.mode === 'UPDATE_BY_KEY' ? 'UPDATE_BY_KEY' : 'CREATE_ONLY';
    const parsed = await parseFile(req.file);
    const requiredHeaders = ENTITIES[entity].columns.filter((row) => row[1]).map((row) => row[0]);
    const missingHeaders = requiredHeaders.filter((header) => !parsed.headers.includes(header));
    if (missingHeaders.length) return res.status(422).json({ success: false, error: `Missing required headers: ${missingHeaders.join(', ')}` });
    const rows = []; const summary = { validNew: 0, validUpdates: 0, duplicates: 0, invalid: 0, warnings: 0 };
    for (const source of parsed.rows) {
      let data = normalize(entity, source.data, hospitalId, req.user._id);
      const errors = validate(entity, data); const warnings = [];
      try { if (!errors.length) data = await resolveReferences(entity, data, hospitalId); } catch (error) { errors.push(error.message); }
      let target = null; let action = 'create';
      if (!errors.length) {
        target = await existing(entity, data, hospitalId);
        if (target) { if (mode === 'UPDATE_BY_KEY') { action = 'update'; summary.validUpdates += 1; } else { action = 'skip'; summary.duplicates += 1; } } else summary.validNew += 1;
        if (entity === 'rate-card-mappings' && !target) errors.push('The referenced rate-card item does not exist');
      }
      if (errors.length) { action = 'invalid'; summary.invalid += 1; }
      rows.push({ rowNumber: source.rowNumber, action, naturalKey: errors.length ? '' : natural(entity, data), errors, warnings, data, targetId: target?._id, before: target?.toObject?.() });
    }
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || crypto.randomUUID();
    const jobEntity = entity;
    const job = await BulkImportJob.findOneAndUpdate({ hospitalId, entity: jobEntity, idempotencyKey }, { hospitalId, entity: jobEntity, status: 'preview_ready', templateVersion: 'insurance-config-v1', originalFileName: req.file.originalname, fileHash, uploadedBy: req.user._id, mode, idempotencyKey, summary, rows }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ success: true, jobId: job._id, summary: job.summary, rows: job.rows });
  } catch (error) { fail(res, error); }
};

exports.commit = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const job = await BulkImportJob.findOne({ _id: req.params.jobId, hospitalId });
    if (!job) return res.status(404).json({ success: false, error: 'Import job not found' });
    if (job.status === 'committed') return res.json({ success: true, idempotent: true, job });
    if (deprecatedServiceImport(res, job.entity)) return;
    if (job.status !== 'preview_ready') return res.status(409).json({ success: false, error: `Job cannot be committed from ${job.status}` });
    if (job.rows.some((row) => row.action === 'invalid')) return res.status(409).json({ success: false, error: 'Resolve invalid rows before commit' });
    job.status = 'committing'; await job.save();
    let created = 0; let updated = 0; let skipped = 0; const affectedCards = new Set();
    for (const row of job.rows) {
      if (row.action === 'skip') { skipped += 1; continue; }
      const data = { ...row.data };
      if (job.entity === 'rate-card-mappings') {
        const item = await RateCardItem.findOne({ _id: row.targetId, hospitalId });
        const targetModel = { Procedure, LabTest, ImagingTest }[data.internalModel];
        if (!targetModel) throw new Error(`Unsupported mapping model ${data.internalModel}`);
        const target = await targetModel.findOne({ hospitalId, code: data.internalCode });
        if (!target) throw new Error(`Internal ${data.internalModel} code ${data.internalCode} not found`);
        await reviewMapping({ hospitalId, rateCardItemId: item._id, action: 'suggest', mapping: { model: data.internalModel, id: target._id, confidence: data.confidence, rationale: data.rationale, suggestedBy: 'import' }, userId: req.user._id, rationale: data.rationale, allowMultipleExternalCodes: data.allowMultipleExternalCodes, requiredForBilling: data.requiredForBilling });
        affectedCards.add(String(item.rateCardId)); updated += 1; row.after = { mappingStatus: 'suggested', internalModel: data.internalModel, internalCode: data.internalCode }; continue;
      }
      const Model = model(job.entity); if (!Model) throw new Error(`No model for ${job.entity}`);
      const current = await existing(job.entity, data, hospitalId);
      if (current && row.action === 'update') {
        row.before = current.toObject();
        const payload = { ...data };
        if (job.entity === 'rate-card-items') { payload.internalService = current.internalService; affectedCards.add(String(current.rateCardId)); }
        current.set(payload); await current.save(); row.targetId = current._id; row.after = current.toObject(); updated += 1;
      } else if (!current) {
        const createdDoc = await Model.create(data); row.targetId = createdDoc._id; row.after = createdDoc.toObject(); created += 1; if (job.entity === 'rate-card-items') affectedCards.add(String(createdDoc.rateCardId));
      } else skipped += 1;
    }
    for (const cardId of affectedCards) await validateRateCard({ hospitalId, rateCardId: cardId, persist: true });
    job.summary.created = created; job.summary.updated = updated; job.summary.skipped = skipped; job.status = 'committed'; job.committedBy = req.user._id; job.commitAt = new Date(); await job.save();
    res.json({ success: true, job: { id: job._id, entity: job.entity, status: job.status, summary: job.summary } });
  } catch (error) {
    const job = await BulkImportJob.findById(req.params.jobId).catch(() => null); if (job && job.status === 'committing') { job.status = 'failed'; job.error = error.message; await job.save().catch(() => {}); }
    fail(res, error);
  }
};

exports.history = async (req, res) => {
  try { const hospitalId = requireHospitalId(req); const filter = { hospitalId }; if (req.query.entity) filter.entity = req.query.entity; const data = await BulkImportJob.find(filter).sort({ createdAt: -1 }).limit(Math.min(100, Number(req.query.limit || 25))).select('-rows'); res.json({ success: true, data }); } catch (error) { fail(res, error); }
};
