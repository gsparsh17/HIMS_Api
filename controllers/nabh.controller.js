'use strict';

const mongoose = require('mongoose');
const NabhSetting = require('../models/NabhSetting');
const NabhRecord = require('../models/NabhRecord');
const NotificationDelivery = require('../models/NotificationDelivery');
const TerminologyCode = require('../models/TerminologyCode');
const HospitalSequence = require('../models/HospitalSequence');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Medicine = require('../models/Medicine');
const HRStaffProfile = require('../models/HRStaffProfile');
const Supplier = require('../models/Supplier');
const FinancialTransaction = require('../models/FinancialTransaction');
const ClaimCase = require('../models/ClaimCase');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Payer = require('../models/Payer');
const User = require('../models/User');
const coverage = require('../config/nabhCoverage');
const workflowTemplates = require('../config/nabhWorkflowTemplates');
const { getOrCreateNabhSetting } = require('../services/nabhSetting.service');
const { queueNotification, processNotification } = require('../services/nabhNotification.service');
const {
  calculateClinicalScores,
  medicationSafetyCheck,
  buildCdssRecommendations,
  staffingForecast
} = require('../services/nabhRules.service');
const { requireHospitalId, objectId } = require('../services/tenantScope.service');
const {
  DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION,
  DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME,
  mergeFinancialPolicyWithDefaults,
  financialPolicyDefaultsPending
} = require('../config/defaultFinancialPolicy');

const ALLOWED_DOMAINS = new Set(['AAC', 'COP', 'MOM', 'DAC', 'DOM', 'FPM', 'HRM', 'IMS']);
const ALLOWED_STATUSES = new Set([
  'draft', 'open', 'scheduled', 'in_progress', 'pending_review',
  'approved', 'completed', 'cancelled', 'rejected', 'archived'
]);


function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function mergeDefined(existing, incoming) {
  if (Array.isArray(incoming)) return incoming.map((item) => (isPlainObject(item) ? mergeDefined({}, item) : item));
  if (!isPlainObject(incoming)) return incoming;
  const result = isPlainObject(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || value === undefined) continue;
    result[key] = isPlainObject(value)
      ? mergeDefined(result[key], value)
      : Array.isArray(value)
        ? value.map((item) => (isPlainObject(item) ? mergeDefined({}, item) : item))
        : value;
  }
  return result;
}

function mergeNotificationChannels(existingChannels = [], incomingChannels) {
  if (!Array.isArray(incomingChannels)) return existingChannels;
  const byChannel = new Map(
    (existingChannels || []).map((item) => [String(item.channel || ''), item])
  );
  return incomingChannels.map((item) => {
    const channel = String(item?.channel || '');
    return mergeDefined(byChannel.get(channel) || {}, item || {});
  });
}

const FINANCIAL_MODES = new Set(['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID', 'TPA_SPONSOR', 'AUTHORIZED_EXCEPTION']);

function validatePaymentModeConfig(config = {}, label = 'financial policy') {
  const allowedModes = Array.from(new Set((config.allowedModes || []).map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)));
  if (allowedModes.some((mode) => !FINANCIAL_MODES.has(mode))) {
    const error = new Error(`${label} contains an unsupported payment mode`);
    error.statusCode = 400;
    throw error;
  }
  const defaultMode = String(config.defaultMode || '').trim().toUpperCase();
  if (defaultMode && allowedModes.length && !allowedModes.includes(defaultMode)) {
    const error = new Error(`${label} default mode must be included in allowed modes`);
    error.statusCode = 400;
    throw error;
  }
  const partial = config.partial || {};
  if (partial.percentage !== undefined && (Number(partial.percentage) < 0 || Number(partial.percentage) > 100)) {
    const error = new Error(`${label} partial percentage must be between 0 and 100`);
    error.statusCode = 400;
    throw error;
  }
  if (partial.allowUserAmount && Number(partial.maxUserAmount || 0) > 0 && Number(partial.minUserAmount || 0) > Number(partial.maxUserAmount || 0)) {
    const error = new Error(`${label} minimum user deposit cannot exceed maximum user deposit`);
    error.statusCode = 400;
    throw error;
  }
}

function validateDiscountTaxConfig(discount = {}, tax = {}, label = 'financial policy') {
  const maxPct = Number(discount.maxPercentage ?? 0);
  const registrarMax = Number(discount.registrarMaxPercentage ?? maxPct);
  const financeMax = Number(discount.financeMaxPercentage ?? maxPct);
  for (const [name, value] of [['maximum discount', maxPct], ['registrar maximum discount', registrarMax], ['finance maximum discount', financeMax]]) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      const error = new Error(`${label} ${name} must be between 0 and 100`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (registrarMax > maxPct) {
    const error = new Error(`${label} registrar discount limit cannot exceed the hospital maximum`);
    error.statusCode = 400;
    throw error;
  }
  if (financeMax > maxPct) {
    const error = new Error(`${label} finance discount limit cannot exceed the hospital maximum`);
    error.statusCode = 400;
    throw error;
  }
  const defaultType = String(discount.defaultType || 'percentage').toLowerCase();
  const defaultValue = Number(discount.defaultValue || 0);
  if (defaultType === 'percentage' && defaultValue > maxPct) {
    const error = new Error(`${label} default discount cannot exceed the hospital percentage maximum`);
    error.statusCode = 400;
    throw error;
  }
  if (defaultType === 'fixed' && defaultValue > Number(discount.maxFixedAmount || 0)) {
    const error = new Error(`${label} default fixed discount cannot exceed the hospital fixed maximum`);
    error.statusCode = 400;
    throw error;
  }
  const taxMin = Number(tax.minRate ?? 0);
  const taxDefault = Number(tax.defaultRate ?? 0);
  const taxMax = Number(tax.maxRate ?? taxDefault);
  if ([taxMin, taxDefault, taxMax].some((value) => !Number.isFinite(value) || value < 0 || value > 100) || taxMin > taxDefault || taxDefault > taxMax) {
    const error = new Error(`${label} tax rates must satisfy 0 <= minimum <= default <= maximum <= 100`);
    error.statusCode = 400;
    throw error;
  }
}

function validateFinancialPolicyConfig(policy = {}) {
  for (const encounter of ['OPD', 'IPD', 'EMERGENCY']) {
    validatePaymentModeConfig(policy.payment?.[encounter] || {}, `${encounter} financial policy`);
  }
  validateDiscountTaxConfig(policy.discount || {}, policy.tax || {}, 'Hospital financial policy');
  for (const [index, rule] of (policy.rules || []).entries()) {
    if (rule.effectiveFrom && rule.effectiveTo && new Date(rule.effectiveFrom) > new Date(rule.effectiveTo)) {
      const error = new Error(`Financial rule ${index + 1} effective-from date cannot be after effective-to date`);
      error.statusCode = 400;
      throw error;
    }
    validatePaymentModeConfig(rule || {}, `Financial rule ${index + 1}`);
    validateDiscountTaxConfig(rule.discount || policy.discount || {}, rule.tax || policy.tax || {}, `Financial rule ${index + 1}`);
  }
}

function publicSetting(setting) {
  const data = setting?.toObject ? setting.toObject() : { ...(setting || {}) };
  for (const channel of data.notifications?.channels || []) delete channel.apiKey;
  if (data.security?.sso) delete data.security.sso.assertionSecret;
  return data;
}

function asInteger(value, fallback, min = 1, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mongoHospitalId(hospitalId) {
  return new mongoose.Types.ObjectId(String(hospitalId));
}

async function validateRecordReferences(hospitalId, input, { currentRecordId } = {}) {
  const singleReferences = [
    ['patientId', Patient, 'hospitalId'],
    ['appointmentId', Appointment, 'hospital_id'],
    ['admissionId', IPDAdmission, 'hospitalId'],
    ['doctorId', Doctor, 'hospitalId'],
    ['staffId', HRStaffProfile, 'hospital_id'],
    ['claimId', ClaimCase, 'hospitalId']
  ];

  for (const [field, Model, tenantField] of singleReferences) {
    if (input[field] === undefined || input[field] === null || input[field] === '') continue;
    if (!mongoose.isValidObjectId(input[field])) {
      const error = new Error(`Invalid ${field}`);
      error.statusCode = 400;
      throw error;
    }
    const exists = await Model.exists({ _id: input[field], [tenantField]: hospitalId }); // eslint-disable-line no-await-in-loop
    if (!exists) {
      const error = new Error(`${field} was not found for this hospital`);
      error.statusCode = 400;
      throw error;
    }
  }

  for (const field of ['supplierId', 'invoiceId']) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== ''
      && !mongoose.isValidObjectId(input[field])) {
      const error = new Error(`Invalid ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }

  if (input.assignedTo !== undefined) {
    if (!Array.isArray(input.assignedTo) || input.assignedTo.length > 100) {
      const error = new Error('assignedTo must be an array with at most 100 users');
      error.statusCode = 400;
      throw error;
    }
    const ids = [...new Set(input.assignedTo.map(String))];
    if (ids.some((id) => !mongoose.isValidObjectId(id))) {
      const error = new Error('assignedTo contains an invalid user identifier');
      error.statusCode = 400;
      throw error;
    }
    if (ids.length) {
      const count = await User.countDocuments({ _id: { $in: ids }, hospital_id: hospitalId });
      if (count !== ids.length) {
        const error = new Error('One or more assigned users were not found for this hospital');
        error.statusCode = 400;
        throw error;
      }
    }
  }

  if (input.relatedRecordIds !== undefined) {
    if (!Array.isArray(input.relatedRecordIds) || input.relatedRecordIds.length > 100) {
      const error = new Error('relatedRecordIds must be an array with at most 100 records');
      error.statusCode = 400;
      throw error;
    }
    const ids = [...new Set(input.relatedRecordIds.map(String))];
    if (currentRecordId && ids.includes(String(currentRecordId))) {
      const error = new Error('A NABH record cannot relate to itself');
      error.statusCode = 400;
      throw error;
    }
    if (ids.some((id) => !mongoose.isValidObjectId(id))) {
      const error = new Error('relatedRecordIds contains an invalid identifier');
      error.statusCode = 400;
      throw error;
    }
    if (ids.length) {
      const count = await NabhRecord.countDocuments({ _id: { $in: ids }, hospitalId });
      if (count !== ids.length) {
        const error = new Error('One or more related records were not found for this hospital');
        error.statusCode = 400;
        throw error;
      }
    }
  }
}

function toCsv(rows, columns) {
  const quote = (value) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [
    columns.map((column) => quote(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => quote(column.value(row))).join(','))
  ].join('\n');
}

async function nextRecordNumber(hospitalId, domain) {
  const now = new Date();
  const key = `NABH_${domain}_${now.getFullYear()}`;
  const sequence = await HospitalSequence.findOneAndUpdate(
    { hospitalId, key },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `${domain}-${now.getFullYear()}-${String(sequence.value).padStart(6, '0')}`;
}

function templateFor(workflowType, requestedDomain) {
  const template = workflowTemplates[workflowType] || workflowTemplates.clinical_operations;
  return {
    ...template,
    domain: requestedDomain && ALLOWED_DOMAINS.has(requestedDomain)
      ? requestedDomain
      : template.domain
  };
}

function splitSteps(text) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) return [];
  const parts = normalized.split(/(?=(?:Scenario\s+\d+[:.]?|Step\s+\d+[:.]?))/gi)
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length ? parts : [normalized];
}

function testCasesByIds(ids = []) {
  const idSet = new Set(ids);
  return coverage.filter((item) => idSet.has(item.testCaseId));
}

function defaultChecklist(template, selectedCases = []) {
  const rows = [];
  for (const item of selectedCases) {
    const steps = splitSteps(item.steps);
    for (const step of steps) {
      rows.push({
        code: `${item.testCaseId}-${rows.length + 1}`,
        label: step.length > 350 ? `${step.slice(0, 347)}...` : step,
        sourceStep: item.testCaseId,
        status: 'pending'
      });
    }
  }
  for (const label of template.checklist || []) {
    if (!rows.some((item) => item.label === label)) {
      rows.push({
        code: `CONTROL-${rows.length + 1}`,
        label,
        status: 'pending'
      });
    }
  }
  return rows.slice(0, 100);
}

function recordFilter(req) {
  const filter = { hospitalId: requireHospitalId(req) };
  if (req.query.domain && ALLOWED_DOMAINS.has(String(req.query.domain).toUpperCase())) {
    filter.domain = String(req.query.domain).toUpperCase();
  }
  if (req.query.workflowType) filter.workflowType = String(req.query.workflowType);
  if (req.query.status && ALLOWED_STATUSES.has(String(req.query.status))) {
    filter.status = String(req.query.status);
  }
  for (const field of [
    'patientId', 'appointmentId', 'admissionId', 'doctorId',
    'staffId', 'supplierId', 'invoiceId', 'claimId'
  ]) {
    if (req.query[field] && mongoose.isValidObjectId(req.query[field])) {
      filter[field] = req.query[field];
    }
  }
  if (req.query.testCaseId) filter.testCaseIds = String(req.query.testCaseId);
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
  }
  if (req.query.q) {
    const regex = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$or = [
      { recordNumber: regex },
      { title: regex },
      { description: regex },
      { objective: regex },
      { tags: regex },
      { externalReference: regex }
    ];
  }
  return filter;
}

async function findRecord(req) {
  const record = await NabhRecord.findOne({
    _id: objectId(req.params.id, 'record id'),
    hospitalId: requireHospitalId(req)
  });
  if (!record) {
    const error = new Error('NABH workflow record not found');
    error.statusCode = 404;
    throw error;
  }
  return record;
}

exports.getCoverage = async (_req, res) => {
  const byCapability = {};
  const byDomain = {};
  for (const row of coverage) {
    byCapability[row.capability] = (byCapability[row.capability] || 0) + 1;
    byDomain[row.domain] = (byDomain[row.domain] || 0) + 1;
  }
  res.json({
    success: true,
    data: coverage,
    summary: { total: coverage.length, byCapability, byDomain },
    workflowTemplates
  });
};

exports.getSettings = async (req, res) => {
  const setting = await getOrCreateNabhSetting(requireHospitalId(req), req.user?._id);
  const data = publicSetting(setting);
  const defaultsPending = financialPolicyDefaultsPending(data.financialPolicy || {});
  data.financialPolicy = mergeFinancialPolicyWithDefaults(data.financialPolicy || {});
  res.json({
    success: true,
    data,
    meta: {
      financialPolicyDefaultsPending: defaultsPending,
      financialPolicyTemplateVersion: DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION,
      financialPolicyTemplateName: DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME
    }
  });
};

exports.getFinancialPolicyOptions = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const requestedType = String(req.query.serviceType || '').trim().toUpperCase();
  const query = String(req.query.q || '').trim();
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = query ? new RegExp(escaped, 'i') : /.*/i;
  const limit = Math.min(Math.max(Number(req.query.limit || 60), 1), 100);

  const serviceTypes = [
    { value: 'LABORATORY', label: 'Lab / Pathology' },
    { value: 'RADIOLOGY', label: 'Radiology / Imaging' },
    { value: 'PROCEDURE', label: 'Procedure' },
    { value: 'OPERATION_THEATRE', label: 'Operation Theatre / Surgery' },
    { value: 'PHARMACY', label: 'Pharmacy POS' },
    { value: 'CONSULTATION', label: 'Doctor consultation / round' },
    { value: 'REGISTRATION', label: 'Registration' },
    { value: 'ADMISSION', label: 'IPD admission' },
    { value: 'BED', label: 'Bed / room accommodation' },
    { value: 'OTHER', label: 'Nursing / other recurring charge' }
  ];

  const payerCategories = [
    ['SELF', 'Self / Cash'],
    ['PMJAY', 'PM-JAY / Ayushman Bharat'],
    ['CGHS', 'CGHS'],
    ['STATE_SCHEME', 'State government scheme'],
    ['ECHS', 'ECHS'],
    ['ESIC', 'ESIC'],
    ['GOVERNMENT_OTHER', 'Other government payer'],
    ['CORPORATE', 'Corporate'],
    ['PRIVATE_INSURER', 'Private insurer'],
    ['TPA', 'TPA'],
    ['TPA_MANAGED', 'TPA managed'],
    ['OTHER', 'Other payer']
  ].map(([value, label]) => ({ value, label }));

  const [departments, payers, labCategories, imagingCategories, procedureCategories] = await Promise.all([
    Department.find({ hospitalId, active: { $ne: false }, isDeleted: { $ne: true } })
      .select('_id code name departmentType clinical').sort({ name: 1 }).lean(),
    Payer.find({ hospitalId, isActive: { $ne: false }, isDeleted: { $ne: true } })
      .select('_id code name type').sort({ name: 1 }).lean(),
    LabTest.distinct('category', { hospitalId, is_active: { $ne: false } }),
    ImagingTest.distinct('category', { hospitalId, is_active: { $ne: false } }),
    Procedure.distinct('category', { hospitalId, is_active: { $ne: false } })
  ]);

  const categories = {
    LABORATORY: labCategories.filter(Boolean).map((value) => String(value).trim().toUpperCase()).filter(Boolean).sort(),
    RADIOLOGY: imagingCategories.filter(Boolean).map((value) => String(value).trim().toUpperCase()).filter(Boolean).sort(),
    PROCEDURE: procedureCategories.filter(Boolean).map((value) => String(value).trim().toUpperCase()).filter(Boolean).sort(),
    OPERATION_THEATRE: procedureCategories.filter(Boolean).map((value) => String(value).trim().toUpperCase()).filter(Boolean).sort(),
    PHARMACY: ['PHARMACY'],
    CONSULTATION: ['DOCTOR_VISIT'],
    REGISTRATION: ['REGISTRATION'],
    ADMISSION: ['ADMISSION'],
    BED: ['ACCOMMODATION'],
    OTHER: ['NURSING']
  };

  const masterQuery = (extra = {}) => ({
    hospitalId,
    is_active: { $ne: false },
    ...extra,
    ...(query ? { $or: [{ name: match }, { code: match }, { category: match }] } : {})
  });

  const mapService = (serviceType, row) => ({
    id: row._id,
    serviceType,
    code: String(row.code || '').trim().toUpperCase(),
    name: String(row.name || '').trim(),
    category: String(row.category || '').trim().toUpperCase()
  });

  let services = [];
  if (!requestedType || requestedType === 'LABORATORY') {
    const rows = await LabTest.find(masterQuery()).select('_id code name category').sort({ name: 1 }).limit(limit).lean();
    services.push(...rows.map((row) => mapService('LABORATORY', row)));
  }
  if (!requestedType || requestedType === 'RADIOLOGY') {
    const rows = await ImagingTest.find(masterQuery()).select('_id code name category').sort({ name: 1 }).limit(limit).lean();
    services.push(...rows.map((row) => mapService('RADIOLOGY', row)));
  }
  if (!requestedType || requestedType === 'PROCEDURE' || requestedType === 'OPERATION_THEATRE') {
    const rows = await Procedure.find(masterQuery()).select('_id code name category').sort({ name: 1 }).limit(limit).lean();
    const mappedType = requestedType === 'OPERATION_THEATRE' ? 'OPERATION_THEATRE' : 'PROCEDURE';
    services.push(...rows.map((row) => mapService(mappedType, row)));
  }

  const virtualServices = [
    { serviceType: 'PHARMACY', code: 'PHARMACY_SALE', name: 'All Pharmacy POS sales', category: 'PHARMACY' },
    { serviceType: 'CONSULTATION', code: '', name: 'All doctor consultations / IPD rounds', category: 'DOCTOR_VISIT' },
    { serviceType: 'REGISTRATION', code: '', name: 'All registration charges', category: 'REGISTRATION' },
    { serviceType: 'ADMISSION', code: '', name: 'All admission charges', category: 'ADMISSION' },
    { serviceType: 'BED', code: '', name: 'All bed / room accommodation charges', category: 'ACCOMMODATION' },
    { serviceType: 'OTHER', code: '', name: 'All nursing / other recurring charges', category: 'NURSING' }
  ].filter((row) => (!requestedType || row.serviceType === requestedType)
    && (!query || match.test(row.name) || match.test(row.code) || match.test(row.category)));
  services.push(...virtualServices);

  if (query) {
    services = services.filter((row) => match.test(row.name) || match.test(row.code) || match.test(row.category));
  }
  services = services.slice(0, limit);

  res.json({
    success: true,
    data: {
      serviceTypes,
      payerCategories,
      departments: departments.map((row) => ({ id: row._id, code: row.code, name: row.name, departmentType: row.departmentType, clinical: row.clinical })),
      payers: payers.map((row) => ({ id: row._id, code: row.code, name: row.name, type: String(row.type || '').toUpperCase() })),
      categories,
      services
    }
  });
};

exports.updateSettings = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const allowed = [
    'patientRegistration', 'financialPolicy', 'dischargePolicy', 'notifications', 'security', 'clinical',
    'medication', 'operations', 'interoperability'
  ];
  const setting = await getOrCreateNabhSetting(hospitalId, req.user?._id, { includeSecrets: true });
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    const existing = setting.get(key)?.toObject?.() || setting.get(key) || {};
    const incoming = req.body[key];
    let merged = mergeDefined(existing, incoming);
    if (key === 'notifications' && Array.isArray(incoming?.channels)) {
      merged.channels = mergeNotificationChannels(existing.channels, incoming.channels);
    }
    if (key === 'financialPolicy') {
      merged = mergeFinancialPolicyWithDefaults(merged);
      validateFinancialPolicyConfig(merged);
    }
    setting.set(key, merged);
  }
  setting.updatedBy = req.user?._id;
  setting.version = Number(setting.version || 0) + 1;
  await setting.save();
  res.json({ success: true, data: publicSetting(setting) });
};

exports.dashboard = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const objectHospitalId = mongoHospitalId(hospitalId);
  const [
    byDomain, byStatus, byWorkflow, overdue,
    recentNotifications, terminology, openCritical
  ] = await Promise.all([
    NabhRecord.aggregate([
      { $match: { hospitalId: objectHospitalId } },
      { $group: { _id: '$domain', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]),
    NabhRecord.aggregate([
      { $match: { hospitalId: objectHospitalId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    NabhRecord.aggregate([
      { $match: { hospitalId: objectHospitalId } },
      { $group: { _id: '$workflowType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]),
    NabhRecord.countDocuments({
      hospitalId,
      dueAt: { $lt: new Date() },
      status: { $nin: ['completed', 'cancelled', 'rejected', 'archived'] }
    }),
    NotificationDelivery.find({ hospitalId }).sort({ createdAt: -1 }).limit(10).lean(),
    TerminologyCode.aggregate([
      { $match: { $or: [{ hospitalId: objectHospitalId }, { hospitalId: null }] } },
      { $group: { _id: '$system', count: { $sum: 1 } } }
    ]),
    NabhRecord.countDocuments({
      hospitalId,
      priority: 'critical',
      status: { $nin: ['completed', 'cancelled', 'rejected', 'archived'] }
    })
  ]);
  res.json({
    success: true,
    data: {
      coverageTotal: coverage.length,
      byDomain,
      byStatus,
      byWorkflow,
      overdue,
      openCritical,
      recentNotifications,
      terminology
    }
  });
};

exports.listRecords = async (req, res) => {
  const page = asInteger(req.query.page, 1);
  const limit = asInteger(req.query.limit, 50, 1, 200);
  const filter = recordFilter(req);
  const [data, total] = await Promise.all([
    NabhRecord.find(filter)
      .populate('patientId', 'patientId uhid first_name last_name phone')
      .populate('doctorId', 'doctorId firstName lastName specialization')
      .populate('staffId', 'employee_code full_name department_name designation')
      .populate('assignedTo', 'name email role')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    NabhRecord.countDocuments(filter)
  ]);
  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
};

exports.createRecord = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const workflowType = String(req.body.workflowType || '').trim();
  if (!workflowType) {
    return res.status(400).json({ error: 'workflowType is required' });
  }
  const requestedIds = Array.isArray(req.body.testCaseIds)
    ? [...new Set(req.body.testCaseIds.map(String))]
    : [];
  const selectedCases = testCasesByIds(requestedIds);
  const selectedIds = new Set(selectedCases.map((item) => item.testCaseId));
  const unknownIds = requestedIds.filter((id) => !selectedIds.has(id));
  if (unknownIds.length) {
    return res.status(400).json({
      error: 'UNKNOWN_TEST_CASE_IDS',
      message: `Unknown NABH test case ID(s): ${unknownIds.join(', ')}`
    });
  }
  await validateRecordReferences(hospitalId, req.body);
  const firstCase = selectedCases[0];
  const template = templateFor(
    workflowType,
    String(req.body.domain || firstCase?.domain || '').toUpperCase()
  );
  const record = await NabhRecord.create({
    hospitalId,
    recordNumber: await nextRecordNumber(hospitalId, template.domain),
    testCaseIds: selectedCases.map((item) => item.testCaseId),
    domain: template.domain,
    workflowType,
    title: req.body.title || firstCase?.testCase || template.title,
    description: req.body.description || firstCase?.testCase || template.description,
    objective: req.body.objective || firstCase?.objective,
    expectedOutcome: req.body.expectedOutcome || firstCase?.expectedOutcome,
    sourcePages: req.body.sourcePages || firstCase?.sourcePages,
    patientId: req.body.patientId || undefined,
    appointmentId: req.body.appointmentId || undefined,
    admissionId: req.body.admissionId || undefined,
    doctorId: req.body.doctorId || undefined,
    staffId: req.body.staffId || undefined,
    supplierId: req.body.supplierId || undefined,
    invoiceId: req.body.invoiceId || undefined,
    claimId: req.body.claimId || undefined,
    relatedRecordIds: req.body.relatedRecordIds || [],
    status: req.body.status || 'open',
    priority: req.body.priority || 'routine',
    source: req.body.source || 'nabh_workspace',
    externalReference: req.body.externalReference,
    assignedTo: req.body.assignedTo || [],
    dueAt: req.body.dueAt,
    data: req.body.data || {},
    checklist: Array.isArray(req.body.checklist) && req.body.checklist.length
      ? req.body.checklist
      : defaultChecklist(template, selectedCases),
    tags: req.body.tags || [],
    timeline: [{
      event: 'record_created',
      toStatus: req.body.status || 'open',
      notes: req.body.creationNote,
      data: { testCaseIds: selectedCases.map((item) => item.testCaseId) },
      by: req.user?._id
    }],
    createdBy: req.user?._id,
    updatedBy: req.user?._id
  });
  res.status(201).json({ success: true, data: record });
};

exports.getRecord = async (req, res) => {
  const record = await findRecord(req);
  await record.populate([
    { path: 'patientId', select: 'patientId uhid first_name last_name phone dob gender allergies' },
    { path: 'doctorId', select: 'doctorId firstName lastName specialization email phone' },
    { path: 'staffId', select: 'employee_code full_name department_name designation' },
    { path: 'assignedTo', select: 'name email role' },
    { path: 'timeline.by', select: 'name email role' },
    { path: 'checklist.completedBy', select: 'name email role' }
  ]);
  res.json({ success: true, data: record });
};

exports.updateRecord = async (req, res) => {
  const record = await findRecord(req);
  if (record.finalisedAt) {
    return res.status(409).json({
      error: 'FINAL_RECORD_IMMUTABLE',
      message: 'Finalised records cannot be edited. Create an amendment instead.'
    });
  }
  const editable = [
    'title', 'description', 'objective', 'expectedOutcome',
    'patientId', 'appointmentId', 'admissionId', 'doctorId',
    'staffId', 'supplierId', 'invoiceId', 'claimId', 'relatedRecordIds',
    'priority', 'source', 'externalReference', 'assignedTo',
    'dueAt', 'data', 'tags', 'attachments'
  ];
  await validateRecordReferences(requireHospitalId(req), req.body, { currentRecordId: record._id });
  for (const field of editable) {
    if (req.body[field] !== undefined) record[field] = req.body[field];
  }
  record.updatedBy = req.user?._id;
  record.timeline.push({
    event: 'record_updated',
    notes: req.body.updateNote,
    by: req.user?._id
  });
  await record.save();
  res.json({ success: true, data: record });
};

exports.transitionRecord = async (req, res) => {
  const record = await findRecord(req);
  const nextStatus = String(req.body.status || '');
  if (!ALLOWED_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (record.finalisedAt && nextStatus !== 'archived') {
    return res.status(409).json({
      error: 'FINAL_RECORD_IMMUTABLE',
      message: 'Finalised records can only be archived'
    });
  }
  const fromStatus = record.status;
  record.status = nextStatus;
  record.updatedBy = req.user?._id;
  if (nextStatus === 'archived') record.archivedAt = new Date();
  record.timeline.push({
    event: req.body.event || 'status_changed',
    fromStatus,
    toStatus: nextStatus,
    notes: req.body.notes,
    data: req.body.data,
    by: req.user?._id
  });
  await record.save();
  res.json({ success: true, data: record });
};

exports.updateChecklist = async (req, res) => {
  const record = await findRecord(req);
  if (record.finalisedAt) {
    return res.status(409).json({ error: 'FINAL_RECORD_IMMUTABLE' });
  }
  const item = record.checklist.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  const status = String(req.body.status || 'pending');
  if (!['pending', 'done', 'not_applicable', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid checklist status' });
  }
  item.status = status;
  item.notes = req.body.notes;
  if (Array.isArray(req.body.evidence)) item.evidence = req.body.evidence;
  item.completedAt = status === 'pending' ? undefined : new Date();
  item.completedBy = status === 'pending' ? undefined : req.user?._id;
  record.updatedBy = req.user?._id;
  record.timeline.push({
    event: 'checklist_updated',
    notes: `${item.label}: ${status}`,
    data: { checklistItemId: item._id, status },
    by: req.user?._id
  });
  await record.save();
  res.json({ success: true, data: record });
};

exports.finaliseRecord = async (req, res) => {
  const record = await findRecord(req);
  if (record.finalisedAt) {
    return res.status(409).json({ error: 'ALREADY_FINALISED' });
  }
  const incomplete = record.checklist.filter((item) => item.status === 'pending');
  const failed = record.checklist.filter((item) => item.status === 'failed');
  if ((incomplete.length || failed.length) && !req.body.overrideIncomplete) {
    return res.status(409).json({
      error: 'CHECKLIST_NOT_READY',
      message: `${incomplete.length} pending and ${failed.length} failed checklist item(s)`,
      pending: incomplete.map((item) => ({ id: item._id, label: item.label })),
      failed: failed.map((item) => ({ id: item._id, label: item.label }))
    });
  }
  const fromStatus = record.status;
  record.finalisedAt = new Date();
  record.finalisedBy = req.user?._id;
  record.status = 'completed';
  record.updatedBy = req.user?._id;
  record.timeline.push({
    event: 'record_finalised',
    fromStatus,
    toStatus: 'completed',
    notes: req.body.notes,
    data: { overrideIncomplete: Boolean(req.body.overrideIncomplete) },
    by: req.user?._id
  });
  await record.save();
  res.json({ success: true, data: record });
};

exports.amendRecord = async (req, res) => {
  const original = await findRecord(req);
  if (!original.finalisedAt) {
    return res.status(409).json({ error: 'ONLY_FINAL_RECORDS_CAN_BE_AMENDED' });
  }
  if (!String(req.body.reason || '').trim()) {
    return res.status(400).json({ error: 'Amendment reason is required' });
  }
  const clone = original.toObject();
  delete clone._id;
  delete clone.createdAt;
  delete clone.updatedAt;
  clone.recordNumber = await nextRecordNumber(original.hospitalId, original.domain);
  clone.status = 'open';
  clone.finalisedAt = undefined;
  clone.finalisedBy = undefined;
  clone.archivedAt = undefined;
  clone.amendmentOf = original._id;
  clone.amendmentReason = String(req.body.reason).trim();
  clone.version = Number(original.version || 1) + 1;
  clone.data = { ...(clone.data || {}), ...(req.body.data || {}) };
  clone.timeline = [{
    event: 'amendment_created',
    notes: clone.amendmentReason,
    data: { originalRecordId: original._id },
    by: req.user?._id
  }];
  clone.createdBy = req.user?._id;
  clone.updatedBy = req.user?._id;
  const amended = await NabhRecord.create(clone);
  res.status(201).json({ success: true, data: amended });
};

exports.listNotifications = async (req, res) => {
  const filter = { hospitalId: requireHospitalId(req) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.eventType) filter.eventType = req.query.eventType;
  const limit = asInteger(req.query.limit, 100, 1, 500);
  const data = await NotificationDelivery.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ success: true, data });
};

exports.createNotification = async (req, res) => {
  if (!String(req.body.body || '').trim()) {
    return res.status(400).json({ error: 'Notification body is required' });
  }
  const delivery = await queueNotification({
    hospitalId: requireHospitalId(req),
    eventType: req.body.eventType || 'manual',
    correlationId: req.body.correlationId,
    recipientType: req.body.recipientType || 'external',
    recipientId: req.body.recipientId,
    recipientName: req.body.recipientName,
    contact: req.body.contact || {},
    requestedChannels: req.body.requestedChannels || ['portal'],
    subject: req.body.subject,
    body: req.body.body,
    payload: req.body.payload || {},
    priority: req.body.priority || 'normal',
    requireAcknowledgement: req.body.requireAcknowledgement,
    createdBy: req.user?._id
  });
  res.status(201).json({ success: true, data: delivery });
};

exports.retryNotification = async (req, res) => {
  const delivery = await NotificationDelivery.findOne({
    _id: objectId(req.params.id, 'notification id'),
    hospitalId: requireHospitalId(req)
  });
  if (!delivery) return res.status(404).json({ error: 'Notification not found' });
  delivery.status = 'queued';
  delivery.nextAttemptAt = new Date();
  await delivery.save();
  await processNotification(delivery);
  res.json({ success: true, data: delivery });
};

exports.acknowledgeNotification = async (req, res) => {
  const delivery = await NotificationDelivery.findOne({
    _id: objectId(req.params.id, 'notification id'),
    hospitalId: requireHospitalId(req)
  });
  if (!delivery) return res.status(404).json({ error: 'Notification not found' });
  delivery.status = 'acknowledged';
  delivery.acknowledgedAt = new Date();
  delivery.acknowledgedBy = req.user?._id;
  delivery.acknowledgementNote = req.body.note;
  await delivery.save();
  res.json({ success: true, data: delivery });
};

exports.listTerminology = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const filter = { $or: [{ hospitalId }, { hospitalId: null }] };
  if (req.query.system) filter.system = req.query.system;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.active !== undefined) filter.active = String(req.query.active) !== 'false';
  if (req.query.q) {
    const regex = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$and = [{ $or: [{ code: regex }, { display: regex }, { synonyms: regex }] }];
  }
  const limit = asInteger(req.query.limit, 100, 1, 500);
  const data = await TerminologyCode.find(filter)
    .sort({ system: 1, display: 1 })
    .limit(limit)
    .lean();
  res.json({ success: true, data });
};

exports.upsertTerminology = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  if (!req.body.system || !req.body.code || !req.body.display) {
    return res.status(400).json({ error: 'system, code, and display are required' });
  }
  const data = await TerminologyCode.findOneAndUpdate(
    {
      hospitalId,
      system: req.body.system,
      version: req.body.version || '',
      code: req.body.code
    },
    {
      $set: {
        display: req.body.display,
        synonyms: req.body.synonyms || [],
        category: req.body.category,
        active: req.body.active !== false,
        sourceUri: req.body.sourceUri,
        metadata: req.body.metadata || {},
        updatedBy: req.user?._id
      },
      $setOnInsert: { createdBy: req.user?._id }
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );
  res.status(201).json({ success: true, data });
};

exports.importTerminology = async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : req.body.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows array is required' });
  }
  if (rows.length > 10000) {
    return res.status(413).json({ error: 'Maximum 10,000 terminology rows per import' });
  }
  const invalidRow = rows.findIndex((row) => (
    !row || !String(row.system || '').trim() || !String(row.code || '').trim() || !String(row.display || '').trim()
  ));
  if (invalidRow !== -1) {
    return res.status(400).json({ error: `Terminology row ${invalidRow + 1} requires system, code, and display` });
  }
  const hospitalId = requireHospitalId(req);
  const operations = rows.map((row) => ({
    updateOne: {
      filter: {
        hospitalId,
        system: row.system,
        version: row.version || '',
        code: row.code
      },
      update: {
        $set: {
          display: row.display,
          synonyms: row.synonyms || [],
          category: row.category,
          active: row.active !== false,
          sourceUri: row.sourceUri,
          metadata: row.metadata || {},
          updatedBy: req.user?._id
        },
        $setOnInsert: { createdBy: req.user?._id }
      },
      upsert: true
    }
  }));
  const result = await TerminologyCode.bulkWrite(operations, { ordered: false });
  res.status(201).json({ success: true, data: result });
};

exports.calculateRisk = async (req, res) => {
  res.json({ success: true, data: calculateClinicalScores(req.body || {}) });
};

exports.medicationCheck = async (req, res) => {
  const data = await medicationSafetyCheck({
    hospitalId: requireHospitalId(req),
    patientId: req.body.patientId,
    medicineIds: req.body.medicineIds || [],
    medicineNames: req.body.medicineNames || []
  });
  res.json({ success: true, data });
};

exports.cdss = async (req, res) => {
  const settings = await getOrCreateNabhSetting(requireHospitalId(req), req.user?._id);
  const alerts = buildCdssRecommendations({ ...req.body, settings });
  res.json({ success: true, data: { alerts, generatedAt: new Date() } });
};

exports.workforceForecast = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  let rows = req.body.history;
  if (!Array.isArray(rows) || !rows.length) {
    const records = await NabhRecord.find({
      hospitalId,
      workflowType: { $in: ['workforce', 'staffing_workload', 'shift_schedule'] },
      createdAt: { $gte: new Date(Date.now() - 90 * 86400000) }
    }).lean();
    rows = records.map((row) => ({ ...row.data, createdAt: row.createdAt }));
  }
  const data = staffingForecast(rows || [], {
    horizonDays: req.body.horizonDays || 7,
    serviceLevel: req.body.serviceLevel || 1
  });
  res.json({ success: true, data });
};

exports.kpiSummary = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const quarter = String(req.query.quarter || '');
  let from = req.query.from ? new Date(req.query.from) : null;
  let to = req.query.to ? new Date(req.query.to) : null;
  if (quarter && /^\d{4}-Q[1-4]$/.test(quarter)) {
    const [year, q] = quarter.split('-Q').map(Number);
    from = new Date(Date.UTC(year, (q - 1) * 3, 1));
    to = new Date(Date.UTC(year, q * 3, 1));
  }
  if (!from || Number.isNaN(from.getTime())) from = new Date(Date.now() - 90 * 86400000);
  if (!to || Number.isNaN(to.getTime())) to = new Date();
  const dateRange = { $gte: from, $lt: to };
  const objectHospitalId = mongoHospitalId(hospitalId);
  const [
    patients, appointments, admissions, labRequests, radiologyRequests,
    medicationErrors, incidents, claims, revenue
  ] = await Promise.all([
    Patient.countDocuments({ hospitalId, registered_at: dateRange }),
    Appointment.countDocuments({ hospital_id: hospitalId, appointment_date: dateRange }),
    IPDAdmission.countDocuments({ hospitalId, admissionDate: dateRange }),
    LabRequest.countDocuments({ hospitalId, requestedDate: dateRange }),
    RadiologyRequest.countDocuments({ hospitalId, requestedDate: dateRange }),
    NabhRecord.countDocuments({ hospitalId, workflowType: 'medication_safety', createdAt: dateRange }),
    NabhRecord.countDocuments({
      hospitalId,
      workflowType: 'infection_incident',
      createdAt: dateRange
    }),
    ClaimCase.countDocuments({ hospitalId, createdAt: dateRange }),
    FinancialTransaction.aggregate([
      { $match: { hospitalId: objectHospitalId, postedAt: dateRange, status: 'POSTED' } },
      { $group: { _id: '$direction', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ])
  ]);
  res.json({
    success: true,
    data: {
      period: { from, to, quarter: quarter || undefined },
      patientRegistrations: patients,
      appointments,
      ipdAdmissions: admissions,
      laboratoryOrders: labRequests,
      radiologyOrders: radiologyRequests,
      medicationSafetyRecords: medicationErrors,
      patientSafetyIncidents: incidents,
      insuranceClaims: claims,
      financialTransactions: revenue
    }
  });
};

exports.kpiExport = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const records = await NabhRecord.find({
    hospitalId,
    workflowType: 'kpi'
  }).sort({ createdAt: -1 }).lean();
  const csv = toCsv(records, [
    { label: 'Record Number', value: (row) => row.recordNumber },
    { label: 'Test Case IDs', value: (row) => row.testCaseIds.join(';') },
    { label: 'Status', value: (row) => row.status },
    { label: 'Quarter', value: (row) => row.data?.quarter },
    { label: 'Metric', value: (row) => row.data?.metric },
    { label: 'Value', value: (row) => row.data?.value },
    { label: 'Created At', value: (row) => row.createdAt }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="nabh-kpi-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(csv);
};

exports.masterData = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const [
    patients, medicines, staff, suppliers,
    doctors, departments, appointments, admissions
  ] = await Promise.all([
    Patient.find({ hospitalId })
      .select('patientId uhid first_name last_name phone')
      .sort({ first_name: 1 }).limit(500).lean(),
    Medicine.find({ hospitalId, is_active: true })
      .select('name generic_name category medicationSafety')
      .sort({ name: 1 }).limit(1000).lean(),
    HRStaffProfile.find({ hospital_id: hospitalId })
      .select('employee_code full_name department_name designation employment_status')
      .sort({ full_name: 1 }).limit(1000).lean(),
    Supplier.find({ isActive: { $ne: false } })
      .select('name companyName contactPerson phone email')
      .sort({ name: 1 }).limit(1000).lean(),
    Doctor.find({ hospitalId })
      .select('doctorId firstName lastName specialization department experience education email phone timeSlots')
      .sort({ firstName: 1 }).limit(500).lean(),
    Department.find({ hospitalId, active: { $ne: false } })
      .select('code name')
      .sort({ name: 1 }).limit(500).lean(),
    Appointment.find({ hospital_id: hospitalId })
      .select('patient_id doctor_id department_id appointment_date visit_mode status token serial_number')
      .sort({ appointment_date: -1 }).limit(500).lean(),
    IPDAdmission.find({ hospitalId })
      .select('patientId admissionNumber admissionDate status wardId roomId bedId primaryDoctorId')
      .sort({ admissionDate: -1 }).limit(500).lean()
  ]);
  res.json({
    success: true,
    data: {
      patients, medicines, staff, suppliers,
      doctors, departments, appointments, admissions
    }
  });
};

exports.deviceCapture = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const deviceType = String(req.body.deviceType || '').trim().toLowerCase();
  const deviceIdentifier = String(req.body.deviceIdentifier || '').trim();
  const allowedDeviceTypes = new Set(['biometric', 'scanner', 'printer', 'barcode_scanner', 'medical_device', 'other']);
  if (!allowedDeviceTypes.has(deviceType) || !deviceIdentifier) {
    return res.status(400).json({
      error: 'deviceType and deviceIdentifier are required',
      allowedDeviceTypes: [...allowedDeviceTypes]
    });
  }
  const capturedAt = req.body.capturedAt ? new Date(req.body.capturedAt) : new Date();
  if (Number.isNaN(capturedAt.getTime())) return res.status(400).json({ error: 'Invalid capturedAt' });
  await validateRecordReferences(hospitalId, req.body);
  const template = templateFor('devices', 'AAC');
  const record = await NabhRecord.create({
    hospitalId,
    recordNumber: await nextRecordNumber(hospitalId, 'AAC'),
    testCaseIds: ['AAC.1.12.l'],
    domain: 'AAC',
    workflowType: 'devices',
    title: req.body.title || template.title,
    patientId: req.body.patientId || undefined,
    staffId: req.body.staffId || undefined,
    priority: req.body.priority || 'routine',
    data: {
      deviceType,
      deviceIdentifier,
      capturedAt,
      payload: req.body.payload,
      checksum: req.body.checksum
    },
    checklist: defaultChecklist(template, []),
    timeline: [{ event: 'device_data_captured', by: req.user?._id }],
    createdBy: req.user?._id,
    updatedBy: req.user?._id
  });
  res.status(201).json({ success: true, data: record });
};

exports.migrationExport = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const settings = await getOrCreateNabhSetting(hospitalId, req.user?._id);
  if (settings.operations?.enableMigrationExports === false) {
    return res.status(403).json({ error: 'Migration exports are disabled' });
  }
  const limit = asInteger(req.query.limit, 10000, 1, 50000);
  const [patients, appointments, records, terminology] = await Promise.all([
    Patient.find({ hospitalId }).limit(limit).lean(),
    Appointment.find({ hospital_id: hospitalId }).limit(limit).lean(),
    NabhRecord.find({ hospitalId }).limit(limit).lean(),
    TerminologyCode.find({ $or: [{ hospitalId }, { hospitalId: null }] }).limit(limit).lean()
  ]);
  const payload = {
    schema: 'mediqliq-hims-nabh-export',
    version: 1,
    exportedAt: new Date(),
    hospitalId,
    settings: publicSetting(settings),
    patients,
    appointments,
    nabhRecords: records,
    terminology
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="hims-migration-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.send(JSON.stringify(payload));
};

exports.migrationImport = async (req, res) => {
  const hospitalId = requireHospitalId(req);
  const payload = req.body || {};
  if (payload.schema !== 'mediqliq-hims-nabh-export' || Number(payload.version) !== 1) {
    return res.status(400).json({ error: 'Unsupported migration payload' });
  }
  const terminologyRows = Array.isArray(payload.terminology)
    ? payload.terminology.slice(0, 50000)
    : [];
  const allowedTerminologySystems = new Set(['ICD-10', 'ICD-11', 'SNOMED_CT', 'LOINC', 'NRCeS', 'LOCAL']);
  const invalidTerminologyRow = terminologyRows.findIndex((row) => (
    !row
      || !allowedTerminologySystems.has(String(row.system || '').trim())
      || !String(row.code || '').trim()
      || !String(row.display || '').trim()
  ));
  if (invalidTerminologyRow !== -1) {
    return res.status(400).json({
      error: `Migration terminology row ${invalidTerminologyRow + 1} requires a supported system, code, and display`
    });
  }

  const result = { records: 0, terminology: 0 };
  if (Array.isArray(payload.nabhRecords)) {
    for (const row of payload.nabhRecords.slice(0, 50000)) {
      if (!row || typeof row !== 'object') continue;
      const sourceId = row._id ? String(row._id) : undefined;
      const sourceHospitalId = row.hospitalId ? String(row.hospitalId) : undefined;
      const sourceRecordNumber = row.recordNumber;
      const sourceStatus = row.status;
      const sourceFinalisedAt = row.finalisedAt;
      const clone = {
        ...row,
        hospitalId,
        status: 'pending_review',
        version: 1,
        data: mergeDefined(row.data || {}, {
          migrationSource: {
            sourceId,
            sourceHospitalId,
            sourceRecordNumber,
            sourceStatus,
            sourceFinalisedAt,
            importedAt: new Date()
          }
        }),
        checklist: Array.isArray(row.checklist)
          ? row.checklist.slice(0, 100).map((item) => ({
            code: item?.code,
            label: item?.label || 'Imported checklist item',
            sourceStep: item?.sourceStep,
            status: item?.status || 'pending',
            notes: item?.notes,
            evidence: Array.isArray(item?.evidence) ? item.evidence.slice(0, 20) : [],
            completedAt: item?.completedAt
          }))
          : [],
        timeline: [{
          event: 'record_imported',
          notes: sourceRecordNumber ? `Imported from ${sourceRecordNumber}` : 'Imported record',
          data: { sourceId, sourceHospitalId, sourceStatus },
          by: req.user?._id
        }],
        attachments: Array.isArray(row.attachments)
          ? row.attachments.slice(0, 100).map((item) => ({
            name: item?.name,
            url: item?.url,
            mimeType: item?.mimeType,
            checksum: item?.checksum,
            addedAt: item?.addedAt
          }))
          : [],
        createdBy: req.user?._id,
        updatedBy: req.user?._id
      };
      clone.domain = ALLOWED_DOMAINS.has(String(clone.domain || '').toUpperCase())
        ? String(clone.domain).toUpperCase()
        : 'DOM';
      clone.workflowType = String(clone.workflowType || 'migration_review').trim() || 'migration_review';
      clone.title = String(clone.title || 'Imported NABH record').trim() || 'Imported NABH record';
      clone.priority = ['low', 'routine', 'urgent', 'critical'].includes(clone.priority)
        ? clone.priority
        : 'routine';
      clone.testCaseIds = Array.isArray(clone.testCaseIds)
        ? [...new Set(clone.testCaseIds.map(String))].filter((id) => coverage.some((item) => item.testCaseId === id)).slice(0, 200)
        : [];
      clone.tags = Array.isArray(clone.tags) ? clone.tags.map(String).slice(0, 100) : [];
      if (clone.dueAt) {
        const dueAt = new Date(clone.dueAt);
        clone.dueAt = Number.isNaN(dueAt.getTime()) ? undefined : dueAt;
      }
      for (const field of [
        '_id', 'createdAt', 'updatedAt', 'patientId', 'appointmentId', 'admissionId',
        'doctorId', 'staffId', 'supplierId', 'invoiceId', 'claimId', 'relatedRecordIds',
        'assignedTo', 'finalisedAt', 'finalisedBy', 'amendmentOf', 'amendmentReason', 'archivedAt'
      ]) delete clone[field];
      clone.recordNumber = await nextRecordNumber( // eslint-disable-line no-await-in-loop
        hospitalId,
        clone.domain
      );
      await NabhRecord.create(clone); // eslint-disable-line no-await-in-loop
      result.records += 1;
    }
  }
  if (terminologyRows.length) {
    const operations = terminologyRows.map((row) => ({
      updateOne: {
        filter: {
          hospitalId,
          system: row.system,
          version: row.version || '',
          code: row.code
        },
        update: {
          $set: {
            display: row.display,
            synonyms: row.synonyms || [],
            category: row.category,
            active: row.active !== false,
            sourceUri: row.sourceUri,
            metadata: row.metadata || {},
            updatedBy: req.user?._id
          },
          $setOnInsert: { createdBy: req.user?._id }
        },
        upsert: true
      }
    }));
    if (operations.length) {
      await TerminologyCode.bulkWrite(operations, { ordered: false });
      result.terminology = operations.length;
    }
  }
  res.status(201).json({ success: true, data: result });
};

exports.archiveDueRecords = async () => {
  const settings = await NabhSetting.find({})
    .select('hospitalId operations.archiveAfterDays')
    .lean();
  let total = 0;
  for (const setting of settings) {
    const cutoff = new Date(
      Date.now() - Number(setting.operations?.archiveAfterDays || 1825) * 86400000
    );
    const result = await NabhRecord.updateMany( // eslint-disable-line no-await-in-loop
      {
        hospitalId: setting.hospitalId,
        createdAt: { $lt: cutoff },
        status: { $in: ['completed', 'cancelled', 'rejected'] },
        archivedAt: { $exists: false }
      },
      { $set: { status: 'archived', archivedAt: new Date() } }
    );
    total += result.modifiedCount || 0;
  }
  return total;
};
