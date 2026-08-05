const mongoose = require('mongoose');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const RateCardItem = require('../models/RateCardItem');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

const MASTER = {
  procedures: {
    model: Procedure,
    modelName: 'Procedure',
    codeField: 'code',
    activeField: 'is_active',
    billableField: 'is_billable',
    searchable: ['code', 'name', 'category', 'subcategory', 'specialty', 'description', 'aliases', 'tags'],
    defaultSort: { category: 1, name: 1 },
    createdBy: 'created_by',
    updatedBy: 'updated_by'
  },
  'lab-tests': {
    model: LabTest,
    modelName: 'LabTest',
    codeField: 'code',
    activeField: 'is_active',
    billableField: 'is_billable',
    searchable: ['code', 'name', 'category', 'subCategory', 'description', 'aliases', 'specimen_detail'],
    defaultSort: { category: 1, name: 1 },
    createdBy: 'createdBy',
    updatedBy: 'updatedBy'
  },
  'imaging-tests': {
    model: ImagingTest,
    modelName: 'ImagingTest',
    codeField: 'code',
    activeField: 'is_active',
    billableField: 'is_billable',
    searchable: ['code', 'name', 'category', 'description', 'aliases'],
    defaultSort: { category: 1, name: 1 },
    createdBy: 'createdBy',
    updatedBy: 'updatedBy'
  }
};

function fail(res, error) {
  const status = error.statusCode || (error.name === 'ValidationError' ? 422 : 400);
  return res.status(status).json({
    success: false,
    error: error.message,
    details: error.name === 'ValidationError'
      ? Object.values(error.errors || {}).map((row) => row.message)
      : undefined
  });
}

function config(entity) {
  const value = MASTER[entity];
  if (!value) {
    const error = new Error('Unsupported service master');
    error.statusCode = 404;
    throw error;
  }
  return value;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bodyWithoutScope(body = {}) {
  const value = { ...body };
  [
    '_id', 'hospitalId', 'hospital_id', '__v', 'createdAt', 'updatedAt',
    'created_by', 'updated_by', 'createdBy', 'updatedBy', 'usage_count', 'last_used'
  ].forEach((key) => delete value[key]);
  return value;
}

function normalizeBody(entity, body) {
  const value = bodyWithoutScope(body);
  if (value.code !== undefined) value.code = String(value.code).trim().toUpperCase();
  if (value.name !== undefined) value.name = String(value.name).trim();
  if (value.category !== undefined) value.category = String(value.category).trim();
  if (entity === 'lab-tests') {
    if (value.specimen_detail === undefined && value.specimenDetail !== undefined) {
      value.specimen_detail = value.specimenDetail;
    }
    delete value.specimenDetail;
  }
  if (entity === 'imaging-tests' && value.template_only === true) {
    value.is_billable = false;
  }
  return value;
}

async function findByIdOrCode(Model, hospitalId, raw) {
  const value = String(raw || '').trim();
  const filter = mongoose.isValidObjectId(value)
    ? { _id: value, hospitalId }
    : { code: value.toUpperCase(), hospitalId };
  return Model.findOne(filter);
}

async function recordPriceHistory(document, nextAmount, userId, reason) {
  if (nextAmount === undefined || Number(document.base_price || 0) === Number(nextAmount)) return;
  const now = new Date();
  const rows = Array.isArray(document.priceHistory) ? document.priceHistory : [];
  const open = rows.find((row) => !row.effectiveTo);
  if (open) open.effectiveTo = new Date(now.getTime() - 1);
  rows.push({
    amount: Number(nextAmount),
    effectiveFrom: now,
    reason: reason || 'Service master price edited',
    changedBy: userId
  });
  document.priceHistory = rows;
}

exports.list = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const filter = { hospitalId };

    const includeInactive = req.query.includeInactive === 'true' || req.query.status === 'all';
    const orderableOnly = req.query.orderableOnly === 'true';
    if (!includeInactive) filter[entry.activeField] = true;
    if (orderableOnly) {
      filter[entry.activeField] = true;
      filter[entry.billableField] = true;
      if (entry.modelName === 'ImagingTest') filter.template_only = { $ne: true };
    }
    if (req.query.status === 'inactive') filter[entry.activeField] = false;
    if (req.query.category) filter.category = req.query.category;
    if (req.query.specialty && entry.modelName === 'Procedure') filter.specialty = req.query.specialty;
    if (req.query.billable !== undefined) filter[entry.billableField] = req.query.billable === 'true';
    if (req.query.q) {
      const expression = new RegExp(escapeRegex(req.query.q), 'i');
      filter.$or = entry.searchable.map((field) => ({ [field]: expression }));
    }

    const [data, total] = await Promise.all([
      entry.model.find(filter).sort(entry.defaultSort).skip((page - 1) * limit).limit(limit).lean(),
      entry.model.countDocuments(filter)
    ]);
    return res.json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.get = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const data = await findByIdOrCode(entry.model, hospitalId, req.params.id);
    if (!data) return res.status(404).json({ success: false, error: 'Service not found' });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

exports.create = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const payload = normalizeBody(req.params.entity, req.body);
    payload.hospitalId = hospitalId;
    payload[entry.createdBy] = req.user._id;
    payload[entry.updatedBy] = req.user._id;
    if (payload.base_price !== undefined) {
      payload.priceHistory = [{
        amount: Number(payload.base_price),
        effectiveFrom: payload.priceEffectiveFrom || new Date(),
        reason: payload.priceChangeReason || 'Initial cash price',
        changedBy: req.user._id
      }];
    }
    delete payload.priceEffectiveFrom;
    delete payload.priceChangeReason;
    const data = await entry.model.create(payload);
    await appendDomainEvent({
      req,
      eventType: `master.${req.params.entity}.created`,
      entityType: entry.modelName,
      entityId: data._id,
      hospitalId,
      afterSummary: { code: data.code, name: data.name, basePrice: data.base_price }
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    if (error?.code === 11000) {
      error.statusCode = 409;
      error.message = 'The service code already exists';
    }
    return fail(res, error);
  }
};

exports.update = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const document = await findByIdOrCode(entry.model, hospitalId, req.params.id);
    if (!document) return res.status(404).json({ success: false, error: 'Service not found' });
    const before = { code: document.code, name: document.name, basePrice: document.base_price, active: document[entry.activeField] };
    const payload = normalizeBody(req.params.entity, req.body);
    await recordPriceHistory(document, payload.base_price, req.user._id, req.body.priceChangeReason);
    delete payload.priceChangeReason;
    Object.assign(document, payload);
    document[entry.updatedBy] = req.user._id;
    await document.save();
    await appendDomainEvent({
      req,
      eventType: `master.${req.params.entity}.updated`,
      entityType: entry.modelName,
      entityId: document._id,
      hospitalId,
      beforeSummary: before,
      afterSummary: { code: document.code, name: document.name, basePrice: document.base_price, active: document[entry.activeField] }
    });
    return res.json({ success: true, data: document });
  } catch (error) {
    if (error?.code === 11000) {
      error.statusCode = 409;
      error.message = 'The service code already exists';
    }
    return fail(res, error);
  }
};

exports.archive = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const document = await findByIdOrCode(entry.model, hospitalId, req.params.id);
    if (!document) return res.status(404).json({ success: false, error: 'Service not found' });

    const approvedMappings = await RateCardItem.countDocuments({
      hospitalId,
      'internalService.model': entry.modelName,
      'internalService.id': document._id,
      'internalService.mappingStatus': 'approved',
      active: true
    });
    if (approvedMappings && req.query.force !== 'true') {
      return res.status(409).json({
        success: false,
        error: 'Service has approved payer mappings. Use force=true after reviewing affected rate cards.',
        approvedMappings
      });
    }
    document[entry.activeField] = false;
    if ('is_billable' in document) document.is_billable = false;
    if ('archived_reason' in document) document.archived_reason = req.body.reason || 'Archived by administrator';
    document[entry.updatedBy] = req.user._id;
    await document.save();
    await appendDomainEvent({
      req,
      eventType: `master.${req.params.entity}.archived`,
      entityType: entry.modelName,
      entityId: document._id,
      hospitalId,
      afterSummary: { code: document.code, name: document.name, approvedMappings }
    });
    return res.json({ success: true, data: document, approvedMappings });
  } catch (error) {
    return fail(res, error);
  }
};

exports.restore = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const document = await findByIdOrCode(entry.model, hospitalId, req.params.id);
    if (!document) return res.status(404).json({ success: false, error: 'Service not found' });
    document[entry.activeField] = true;
    if (req.body.is_billable !== undefined) document[entry.billableField] = Boolean(req.body.is_billable);
    document[entry.updatedBy] = req.user._id;
    await document.save();
    return res.json({ success: true, data: document });
  } catch (error) {
    return fail(res, error);
  }
};

exports.incrementUsage = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const entry = config(req.params.entity);
    const document = await findByIdOrCode(entry.model, hospitalId, req.params.id);
    if (!document) return res.status(404).json({ success: false, error: 'Service not found' });
    await document.incrementUsage();
    return res.json({ success: true, data: { id: document._id, code: document.code, usage_count: document.usage_count } });
  } catch (error) {
    return fail(res, error);
  }
};

exports.summary = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const rows = await Promise.all(Object.entries(MASTER).map(async ([entity, entry]) => {
      const [total, active, billable, zeroPriced] = await Promise.all([
        entry.model.countDocuments({ hospitalId }),
        entry.model.countDocuments({ hospitalId, [entry.activeField]: true }),
        entry.model.countDocuments({ hospitalId, [entry.activeField]: true, [entry.billableField]: true }),
        entry.model.countDocuments({ hospitalId, [entry.activeField]: true, [entry.billableField]: true, base_price: { $lte: 0 } })
      ]);
      return { entity, total, active, billable, zeroPriced };
    }));
    return res.json({ success: true, data: rows });
  } catch (error) {
    return fail(res, error);
  }
};
