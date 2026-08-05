const crypto = require('crypto');
const fs = require('fs');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const ClaimCase = require('../models/ClaimCase');
const { requireHospitalId } = require('../services/tenantScope.service');
const { quotePricing } = require('../services/pricingEngine.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { validateRateCard, activationGate } = require('../services/tariffValidation.service');
const { suggestMappings, reviewMapping, mappingCoverage } = require('../services/tariffMapping.service');
const { prepareRateCardReadiness } = require('../services/rateCardReadiness.service');

function fail(res, error) {
  const status = error.statusCode || (error.name === 'ValidationError' ? 422 : 400);
  res.status(status).json({
    success: false,
    error: error.message,
    code: error.code,
    details: error.details || error.conflicts
  });
}
function scopedBody(body = {}) {
  const value = { ...body };
  ['hospitalId', 'hospital_id', '_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].forEach((key) => delete value[key]);
  return value;
}
function editable(card) {
  return ['draft', 'staging', 'pending_approval', 'rejected'].includes(card.status);
}

function inheritCardSourceRow(card, sourceRow = {}) {
  const row = { ...(sourceRow?.toObject?.() || sourceRow || {}) };
  const hasRowReference = Boolean(row.page || row.sheet || row.annexure);
  const cardReference = String(card?.source?.pageOrAnnexure || '').trim();
  if (!hasRowReference && cardReference) {
    row.annexure = cardReference;
    row.raw = {
      ...(row.raw || {}),
      sourceReferenceInheritedFromRateCard: true,
      sourceReferenceInheritedAt: new Date()
    };
  }
  return row;
}

exports.listPayers = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.active !== undefined) filter.isActive = req.query.active === 'true';
    if (req.query.demoOnly !== undefined) filter.demoOnly = req.query.demoOnly === 'true';
    if (req.query.q) filter.$or = [
      { code: { $regex: req.query.q, $options: 'i' } },
      { name: { $regex: req.query.q, $options: 'i' } }
    ];
    const data = await Payer.find(filter).sort({ type: 1, name: 1 });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.getPayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await Payer.findOne({ _id: req.params.id, hospitalId });
    if (!data) return res.status(404).json({ success: false, error: 'Payer not found' });
    const rateCards = await RateCard.find({ hospitalId, payerId: data._id }).sort({ effectiveFrom: -1 });
    res.json({ success: true, data, rateCards });
  } catch (error) { fail(res, error); }
};

exports.createPayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payload = scopedBody(req.body);
    payload.code = String(payload.code || '').trim().toUpperCase();
    const data = await Payer.create({ ...payload, hospitalId, createdBy: req.user._id, updatedBy: req.user._id });
    await appendDomainEvent({ req, eventType: 'payer.created', entityType: 'Payer', entityId: data._id, hospitalId, afterSummary: { code: data.code, name: data.name, type: data.type } });
    res.status(201).json({ success: true, data });
  } catch (error) {
    if (error.code === 11000) { error.statusCode = 409; error.message = 'Payer code already exists'; }
    fail(res, error);
  }
};

exports.updatePayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payer = await Payer.findOne({ _id: req.params.id, hospitalId });
    if (!payer) return res.status(404).json({ success: false, error: 'Payer not found' });
    const before = { code: payer.code, name: payer.name, isActive: payer.isActive, empanelment: payer.empanelment?.status };
    const payload = scopedBody(req.body);
    if (payload.code) payload.code = String(payload.code).trim().toUpperCase();
    Object.assign(payer, payload, { updatedBy: req.user._id });
    await payer.save();
    await appendDomainEvent({ req, eventType: 'payer.updated', entityType: 'Payer', entityId: payer._id, hospitalId, beforeSummary: before, afterSummary: { code: payer.code, name: payer.name, isActive: payer.isActive, empanelment: payer.empanelment?.status } });
    res.json({ success: true, data: payer });
  } catch (error) { fail(res, error); }
};

exports.archivePayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payer = await Payer.findOne({ _id: req.params.id, hospitalId });
    if (!payer) return res.status(404).json({ success: false, error: 'Payer not found' });
    const activeCoverages = await AdmissionCoverage.countDocuments({ hospitalId, payerId: payer._id, active: true });
    const openClaims = await ClaimCase.countDocuments({ hospitalId, payerId: payer._id, status: { $nin: ['settled', 'closed', 'cancelled', 'rejected'] } });
    if ((activeCoverages || openClaims) && req.query.force !== 'true') {
      return res.status(409).json({ success: false, error: 'Payer has active coverages or open claims', activeCoverages, openClaims });
    }
    payer.isActive = false;
    payer.updatedBy = req.user._id;
    await payer.save();
    await RateCard.updateMany({ hospitalId, payerId: payer._id, status: 'active' }, { $set: { status: 'closed', effectiveTo: new Date(), updatedBy: req.user._id } });
    res.json({ success: true, data: payer, activeCoverages, openClaims });
  } catch (error) { fail(res, error); }
};

exports.listRateCards = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (req.query.payerId) filter.payerId = req.query.payerId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.demoOnly !== undefined) filter.demoOnly = req.query.demoOnly === 'true';
    if (req.query.effectiveOn) {
      const d = new Date(req.query.effectiveOn);
      filter.effectiveFrom = { $lte: d };
      filter.$or = [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: d } }];
    }
    const data = await RateCard.find(filter).populate('payerId', 'code name type isActive empanelment demoOnly').sort({ effectiveFrom: -1 });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.createRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payer = await Payer.findOne({ _id: req.body.payerId, hospitalId });
    if (!payer) return res.status(404).json({ success: false, error: 'Payer not found' });
    const payload = scopedBody(req.body);
    payload.status = 'staging';
    payload.demoOnly = Boolean(payload.demoOnly || payer.demoOnly);
    const data = await RateCard.create({ ...payload, hospitalId, createdBy: req.user._id, updatedBy: req.user._id });
    res.status(201).json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.updateRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card) return res.status(404).json({ success: false, error: 'Rate card not found' });
    if (!editable(card)) return res.status(409).json({ success: false, error: 'Activated or closed rate cards cannot be edited; create a new version' });
    const payload = scopedBody(req.body);
    ['status', 'approval', 'quality', 'itemCount', 'revision', 'payerId'].forEach((key) => delete payload[key]);
    Object.assign(card, payload, { updatedBy: req.user._id, revision: Number(card.revision || 0) + 1 });
    // Editing after approval invalidates approval.
    card.approval.firstApprovedBy = undefined;
    card.approval.firstApprovedAt = undefined;
    card.approval.secondApprovedBy = undefined;
    card.approval.secondApprovedAt = undefined;
    card.status = 'staging';
    await card.save();
    res.json({ success: true, data: card });
  } catch (error) { fail(res, error); }
};

exports.getRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await RateCard.findOne({ _id: req.params.id, hospitalId }).populate('payerId').populate('approval.firstApprovedBy approval.secondApprovedBy approval.activatedBy', 'name email role');
    if (!data) return res.status(404).json({ success: false, error: 'Rate card not found' });
    const itemFilter = { hospitalId, rateCardId: data._id };
    if (req.query.mappingStatus) itemFilter['internalService.mappingStatus'] = req.query.mappingStatus;
    if (req.query.serviceType) itemFilter.serviceType = req.query.serviceType;
    if (req.query.active !== undefined) itemFilter.active = req.query.active === 'true';
    if (req.query.q) itemFilter.$or = [{ externalCode: { $regex: req.query.q, $options: 'i' } }, { externalName: { $regex: req.query.q, $options: 'i' } }];
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 100)));
    const [items, total, coverage] = await Promise.all([
      RateCardItem.find(itemFilter).sort({ 'sourceRow.serialNumber': 1, externalCode: 1 }).skip((page - 1) * limit).limit(limit),
      RateCardItem.countDocuments(itemFilter),
      mappingCoverage({ hospitalId, rateCardId: data._id })
    ]);
    res.json({ success: true, data, items, mappingCoverage: coverage, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { fail(res, error); }
};

exports.upsertRateCardItems = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card || !editable(card)) return res.status(409).json({ success: false, error: 'Rate card is not editable' });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, error: 'items array is required' });
    const operations = items.map((raw) => {
      const item = scopedBody(raw);
      const externalCode = String(item.externalCode || '').trim().toUpperCase();
      if (!externalCode) { const error = new Error('Every item requires externalCode'); error.statusCode = 422; throw error; }
      item.sourceRow = inheritCardSourceRow(card, item.sourceRow);
      delete item.internalService?.approvedBy;
      delete item.internalService?.approvedAt;
      return {
        updateOne: {
          filter: { hospitalId, rateCardId: card._id, externalCode },
          update: { $set: { ...item, externalCode, hospitalId, payerId: card.payerId, rateCardId: card._id } },
          upsert: true
        }
      };
    });
    await RateCardItem.bulkWrite(operations, { ordered: false });
    card.itemCount = await RateCardItem.countDocuments({ hospitalId, rateCardId: card._id });
    card.status = 'staging';
    card.approval.firstApprovedBy = undefined;
    card.approval.firstApprovedAt = undefined;
    card.approval.secondApprovedBy = undefined;
    card.approval.secondApprovedAt = undefined;
    card.updatedBy = req.user._id;
    card.revision += 1;
    await card.save({ validateBeforeSave: false });
    const validation = req.body.validate === false ? null : await validateRateCard({ hospitalId, rateCardId: card._id, persist: true });
    res.json({ success: true, itemCount: card.itemCount, validation: validation?.quality });
  } catch (error) { fail(res, error); }
};

exports.updateRateCardItem = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card || !editable(card)) return res.status(409).json({ success: false, error: 'Rate card is not editable' });
    const item = await RateCardItem.findOne({ _id: req.params.itemId, hospitalId, rateCardId: card._id });
    if (!item) return res.status(404).json({ success: false, error: 'Rate-card item not found' });
    const payload = scopedBody(req.body);
    ['hospitalId', 'rateCardId', 'payerId'].forEach((key) => delete payload[key]);
    if (payload.sourceRow !== undefined) payload.sourceRow = inheritCardSourceRow(card, payload.sourceRow);
    Object.assign(item, payload);
    await item.save();
    card.status = 'staging';
    card.updatedBy = req.user._id;
    card.revision += 1;
    await card.save({ validateBeforeSave: false });
    res.json({ success: true, data: item });
  } catch (error) { fail(res, error); }
};

exports.deleteRateCardItem = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card || !editable(card)) return res.status(409).json({ success: false, error: 'Rate card is not editable' });
    const item = await RateCardItem.findOneAndDelete({ _id: req.params.itemId, hospitalId, rateCardId: card._id });
    if (!item) return res.status(404).json({ success: false, error: 'Rate-card item not found' });
    card.itemCount = await RateCardItem.countDocuments({ hospitalId, rateCardId: card._id });
    card.status = 'staging'; card.updatedBy = req.user._id; card.revision += 1;
    await card.save({ validateBeforeSave: false });
    res.json({ success: true, deletedId: item._id, itemCount: card.itemCount });
  } catch (error) { fail(res, error); }
};

exports.deleteRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card) return res.status(404).json({ success: false, error: 'Rate card not found' });
    if (!['draft', 'staging', 'rejected'].includes(card.status)) return res.status(409).json({ success: false, error: 'Only draft, staging or rejected rate cards can be deleted' });
    const useCount = await AdmissionCoverage.countDocuments({ hospitalId, rateCardId: card._id });
    if (useCount) return res.status(409).json({ success: false, error: 'Rate card is referenced by encounter coverage and cannot be deleted', useCount });
    await RateCardItem.deleteMany({ hospitalId, rateCardId: card._id });
    await card.deleteOne();
    res.json({ success: true, deletedId: card._id });
  } catch (error) { fail(res, error); }
};

exports.validateRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await validateRateCard({ hospitalId, rateCardId: req.params.id, persist: true });
    res.json({ success: true, data: { quality: result.quality, mappingPercentage: result.mappingPercentage, activationGate: result.gate, itemCount: result.itemCount } });
  } catch (error) { fail(res, error); }
};

exports.prepareRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await prepareRateCardReadiness({
      hospitalId,
      rateCardId: req.params.id,
      userId: req.user._id,
      persist: true,
      suggest: req.body.suggest !== false,
      threshold: req.body.threshold,
      limitPerItem: req.body.limitPerItem,
      overwriteSuggested: req.body.overwriteSuggested,
      verifiedNames: req.body.verifiedNames || {}
    });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.suggestMappings = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await suggestMappings({ hospitalId, rateCardId: req.params.id, threshold: req.body.threshold, limitPerItem: req.body.limitPerItem, overwriteSuggested: req.body.overwriteSuggested, userId: req.user._id });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.reviewMapping = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await reviewMapping({ hospitalId, rateCardItemId: req.params.itemId, action: req.body.action, mapping: req.body.mapping, userId: req.user._id, rationale: req.body.rationale, rejectionReason: req.body.rejectionReason, allowMultipleExternalCodes: req.body.allowMultipleExternalCodes, requiredForBilling: req.body.requiredForBilling });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.bulkReviewMappings = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const rows = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rows.length) return res.status(422).json({ success: false, error: 'items array is required' });
    const results = [];
    for (const row of rows) {
      try {
        const data = await reviewMapping({ hospitalId, rateCardItemId: row.itemId, action: row.action, mapping: row.mapping, userId: req.user._id, rationale: row.rationale, rejectionReason: row.rejectionReason, allowMultipleExternalCodes: row.allowMultipleExternalCodes, requiredForBilling: row.requiredForBilling });
        results.push({ itemId: row.itemId, success: true, data });
      } catch (error) {
        results.push({ itemId: row.itemId, success: false, error: error.message });
      }
    }
    res.status(results.some((row) => !row.success) ? 207 : 200).json({ success: results.every((row) => row.success), results });
  } catch (error) { fail(res, error); }
};

exports.approveRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card) return res.status(404).json({ success: false, error: 'Rate card not found' });
    if (!['staging', 'pending_approval', 'rejected'].includes(card.status)) return res.status(409).json({ success: false, error: 'Rate card cannot be approved in its current status' });
    const validation = await validateRateCard({ hospitalId, rateCardId: card._id, persist: true });
    if (validation.quality.criticalErrors) return res.status(409).json({ success: false, error: 'Critical validation errors must be resolved before approval', validation: validation.quality });
    const stage = req.body.stage || (!card.approval.firstApprovedBy ? 'first' : 'second');
    if (stage === 'first') {
      card.approval.firstApprovedBy = req.user._id;
      card.approval.firstApprovedAt = new Date();
      card.approval.secondApprovedBy = undefined;
      card.approval.secondApprovedAt = undefined;
      card.status = 'pending_approval';
    } else {
      if (!card.approval.firstApprovedBy) return res.status(409).json({ success: false, error: 'First approval is required' });
      if (String(card.approval.firstApprovedBy) === String(req.user._id)) return res.status(409).json({ success: false, error: 'Second approval must be performed by another user' });
      card.approval.secondApprovedBy = req.user._id;
      card.approval.secondApprovedAt = new Date();
      card.status = 'pending_activation';
    }
    card.approval.rejectedBy = undefined; card.approval.rejectedAt = undefined; card.approval.rejectionReason = undefined;
    card.updatedBy = req.user._id; card.revision += 1;
    await card.save({ validateBeforeSave: false });
    await appendDomainEvent({ req, eventType: stage === 'first' ? 'rate_card.first_approved' : 'rate_card.second_approved', entityType: 'RateCard', entityId: card._id, hospitalId, afterSummary: { status: card.status, version: card.version, itemCount: card.itemCount } });
    res.json({ success: true, data: card });
  } catch (error) { fail(res, error); }
};

exports.activateRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await validateRateCard({ hospitalId, rateCardId: req.params.id, persist: true });
    const card = result.card;
    if (card.status !== 'pending_activation') return res.status(409).json({ success: false, error: 'Rate card must have two approvals before activation' });
    const gate = await activationGate({ card, hospitalId, quality: result.quality, mappingPercentage: result.mappingPercentage });
    if (!gate.ready) return res.status(409).json({ success: false, error: 'Activation gates are not satisfied', gate });
    if ([card.approval.firstApprovedBy, card.approval.secondApprovedBy].some((id) => String(id) === String(req.user._id))) {
      return res.status(409).json({ success: false, error: 'Activation must be performed by an authorised user other than both approvers' });
    }
    await RateCard.updateMany({ hospitalId, payerId: card.payerId, status: 'active', _id: { $ne: card._id } }, { $set: { status: 'closed', effectiveTo: new Date(card.effectiveFrom.getTime() - 1), updatedBy: req.user._id } });
    card.status = 'active'; card.approval.activatedBy = req.user._id; card.approval.activatedAt = new Date(); card.updatedBy = req.user._id; card.revision += 1;
    await card.save({ validateBeforeSave: false });
    await appendDomainEvent({ req, eventType: 'rate_card.activated', entityType: 'RateCard', entityId: card._id, hospitalId, afterSummary: { status: card.status, version: card.version, itemCount: card.itemCount } });
    res.json({ success: true, data: card, gate });
  } catch (error) { fail(res, error); }
};

exports.rejectRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card) return res.status(404).json({ success: false, error: 'Rate card not found' });
    if (!req.body.reason) return res.status(422).json({ success: false, error: 'reason is required' });
    card.status = 'rejected'; card.approval.rejectedBy = req.user._id; card.approval.rejectedAt = new Date(); card.approval.rejectionReason = req.body.reason; card.updatedBy = req.user._id; card.revision += 1;
    await card.save({ validateBeforeSave: false });
    res.json({ success: true, data: card });
  } catch (error) { fail(res, error); }
};

exports.verifySource = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const card = await RateCard.findOne({ _id: req.params.id, hospitalId });
    if (!card) return res.status(404).json({ success: false, error: 'Rate card not found' });
    card.source = card.source || {};
    if (req.body.checksum) card.source.checksum = String(req.body.checksum).trim().toLowerCase();
    if (req.body.attachmentUrl) card.source.attachmentUrl = req.body.attachmentUrl;
    if (req.body.verified) {
      if (!/^[a-f0-9]{64}$/i.test(String(card.source.checksum || ''))) {
        return res.status(422).json({ success: false, error: 'A valid SHA-256 source checksum is required before verification' });
      }
      if (!card.source.title && !card.source.filename && !card.source.attachmentUrl) {
        return res.status(422).json({ success: false, error: 'Source title, filename or attachment is required before verification' });
      }
      const validation = await validateRateCard({ hospitalId, rateCardId: card._id, persist: false });
      if (Number(validation.quality.sourceTraceabilityErrors || 0) > 0) {
        return res.status(409).json({
          success: false,
          error: 'Source verification cannot be completed while row-level source traceability errors remain',
          sourceTraceabilityErrors: validation.quality.sourceTraceabilityErrors
        });
      }
    }
    card.source.verifiedAgainstSource = Boolean(req.body.verified);
    card.source.verifiedBy = req.body.verified ? req.user._id : undefined;
    card.source.verifiedAt = req.body.verified ? new Date() : undefined;
    card.updatedBy = req.user._id;
    await card.save({ validateBeforeSave: false });
    res.json({ success: true, data: card.source });
  } catch (error) { fail(res, error); }
};

exports.quote = async (req, res) => {
  try { const hospitalId = requireHospitalId(req); const data = await quotePricing({ ...req.body, hospitalId }); res.json({ success: true, data }); } catch (error) { fail(res, error); }
};

exports.checksum = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'file is required' });
    const hash = crypto.createHash('sha256'); hash.update(req.file.buffer || fs.readFileSync(req.file.path));
    res.json({ success: true, checksum: hash.digest('hex'), filename: req.file.originalname });
  } catch (error) { fail(res, error); }
};
