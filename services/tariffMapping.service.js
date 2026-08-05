const mongoose = require('mongoose');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const Procedure = require('../models/Procedure');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Bed = require('../models/Bed');
const BillingServiceMaster = require('../models/BillingServiceMaster');
const Medicine = require('../models/Medicine');

const MODEL = { Procedure, LabTest, ImagingTest, Bed, BillingServiceMaster, Medicine };

const STOP = new Set(['the', 'and', 'with', 'without', 'for', 'of', 'to', 'in', 'by', 'per', 'including', 'excluding', 'procedure', 'test', 'scan', 'investigation', 'service']);
function normalize(value) {
  return String(value || '')
    .toLocaleLowerCase('en-IN')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function tokens(value) {
  return new Set(normalize(value).split(/\s+/).filter((token) => token.length > 1 && !STOP.has(token)));
}
function jaccard(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}
function similarity(externalName, candidate) {
  const target = normalize(externalName);
  const candidateNames = [candidate.name, candidate.chargeName, candidate.bedNumber, candidate.code, candidate.chargeCode, candidate.bedCode, ...(candidate.aliases || [])].filter(Boolean);
  let best = 0;
  for (const name of candidateNames) {
    const normalized = normalize(name);
    if (!normalized) continue;
    if (target === normalized) best = Math.max(best, 1);
    else if (target.includes(normalized) || normalized.includes(target)) best = Math.max(best, 0.9);
    else best = Math.max(best, jaccard(target, normalized));
  }
  return Number(best.toFixed(4));
}

function modelCandidates(serviceType) {
  if (serviceType === 'laboratory') return ['LabTest'];
  if (serviceType === 'radiology') return ['ImagingTest'];
  if (['procedure', 'ot', 'consultation'].includes(serviceType)) return ['Procedure', 'BillingServiceMaster'];
  if (serviceType === 'bed') return ['Bed', 'BillingServiceMaster'];
  if (serviceType === 'pharmacy') return ['Medicine'];
  return ['BillingServiceMaster', 'Procedure'];
}

function candidateFilter(modelName, hospitalId) {
  const common = { hospitalId };
  if (modelName === 'Procedure') return { ...common, is_active: { $ne: false }, is_billable: { $ne: false } };
  if (modelName === 'LabTest') return { ...common, is_active: { $ne: false }, is_billable: { $ne: false } };
  if (modelName === 'ImagingTest') return { ...common, is_active: { $ne: false }, is_billable: { $ne: false }, template_only: { $ne: true }, serviceRole: { $ne: 'REPORT_TEMPLATE_ONLY' } };
  if (modelName === 'Bed') return { ...common, isActive: true };
  if (modelName === 'BillingServiceMaster') return { ...common, active: true };
  if (modelName === 'Medicine') return { ...common, is_active: true };
  return common;
}

function candidateProjection(modelName) {
  if (modelName === 'Bed') return 'bedCode bedNumber bedType dailyCharge';
  if (modelName === 'BillingServiceMaster') return 'chargeCode chargeName category serviceType price';
  if (modelName === 'Medicine') return 'name generic_name brand category nlem_code';
  return 'code name aliases category subcategory specialty base_price';
}

function candidateDescriptor(modelName, row) {
  return {
    model: modelName,
    id: row._id,
    code: row.code || row.chargeCode || row.bedCode || row.nlem_code || '',
    name: row.name || row.chargeName || row.bedNumber || row.generic_name || ''
  };
}

async function suggestMappings({ hospitalId, rateCardId, threshold = 0.55, limitPerItem = 5, overwriteSuggested = false, userId, persist = true }) {
  const card = await RateCard.findOne({ _id: rateCardId, hospitalId });
  if (!card) { const error = new Error('Rate card not found'); error.statusCode = 404; throw error; }
  const items = await RateCardItem.find({ hospitalId, rateCardId, active: true });
  const modelNames = [...new Set(items.flatMap((item) => modelCandidates(item.serviceType)))];
  const catalogue = {};
  await Promise.all(modelNames.map(async (modelName) => {
    catalogue[modelName] = await MODEL[modelName].find(candidateFilter(modelName, hospitalId)).select(candidateProjection(modelName)).lean();
  }));

  const results = [];
  for (const item of items) {
    if (item.internalService?.mappingStatus === 'approved') continue;
    if (!overwriteSuggested && ['suggested', 'reviewed'].includes(item.internalService?.mappingStatus)) continue;
    const suggestions = [];
    modelCandidates(item.serviceType).forEach((modelName) => {
      (catalogue[modelName] || []).forEach((row) => {
        const score = similarity(item.externalName, row);
        if (score >= Number(threshold)) suggestions.push({ ...candidateDescriptor(modelName, row), confidence: score });
      });
    });
    suggestions.sort((a, b) => b.confidence - a.confidence || String(a.name).localeCompare(String(b.name)));
    const top = suggestions.slice(0, Number(limitPerItem));
    if (top.length) {
      const winner = top[0];
      item.internalService = {
        ...winner,
        mappingStatus: 'suggested',
        rationale: `Name similarity ${winner.confidence}; generated conservatively and requires human approval`,
        suggestedBy: 'system',
        suggestedAt: new Date()
      };
      if (persist) await item.save({ validateBeforeSave: false });
    }
    results.push({ itemId: item._id, externalCode: item.externalCode, externalName: item.externalName, suggestions: top });
  }
  return {
    rateCardId: card._id,
    evaluated: results.length,
    suggested: results.filter((row) => row.suggestions.length).length,
    noMatch: results.filter((row) => !row.suggestions.length).length,
    persisted: Boolean(persist),
    results
  };
}

async function targetRecord({ hospitalId, modelName, id }) {
  const Model = MODEL[modelName];
  if (!Model) { const error = new Error('Unsupported internal service model'); error.statusCode = 422; throw error; }
  const record = await Model.findOne({ _id: id, hospitalId });
  if (!record) { const error = new Error('Internal service not found'); error.statusCode = 404; throw error; }
  return record;
}

async function reviewMapping({ hospitalId, rateCardItemId, action, mapping, userId, rationale, rejectionReason, allowMultipleExternalCodes = false, requiredForBilling }) {
  const item = await RateCardItem.findOne({ _id: rateCardItemId, hospitalId });
  if (!item) { const error = new Error('Rate-card item not found'); error.statusCode = 404; throw error; }
  if (!['suggest', 'review', 'approve', 'reject', 'clear', 'mark_unavailable', 'restore_required'].includes(action)) { const error = new Error('Invalid mapping action'); error.statusCode = 422; throw error; }
  const now = new Date();
  if (action === 'clear' || action === 'restore_required') {
    item.internalService = { mappingStatus: 'unmapped' };
    item.mappingOptions = {
      ...(item.mappingOptions?.toObject?.() || item.mappingOptions || {}),
      allowMultipleExternalCodes: false,
      requiredForBilling: true,
      unavailableAtHospital: false,
      note: rationale || (action === 'restore_required' ? 'Restored as a required hospital-service mapping' : undefined)
    };
  } else if (action === 'mark_unavailable') {
    item.internalService = {
      mappingStatus: 'rejected',
      rejectedBy: userId,
      rejectedAt: now,
      rejectionReason: rejectionReason || 'Service is not offered by this hospital',
      reviewedBy: userId,
      reviewedAt: now
    };
    item.mappingOptions = {
      ...(item.mappingOptions?.toObject?.() || item.mappingOptions || {}),
      requiredForBilling: false,
      unavailableAtHospital: true,
      note: rationale || rejectionReason || 'Not offered by this hospital'
    };
  } else if (action === 'reject') {
    item.internalService = {
      ...(item.internalService?.toObject?.() || item.internalService || {}),
      mappingStatus: 'rejected', rejectedBy: userId, rejectedAt: now,
      rejectionReason: rejectionReason || 'Rejected during mapping review',
      reviewedBy: userId, reviewedAt: now
    };
  } else {
    const source = mapping || item.internalService;
    if (!source?.model || !source?.id) { const error = new Error('mapping.model and mapping.id are required'); error.statusCode = 422; throw error; }
    const record = await targetRecord({ hospitalId, modelName: source.model, id: source.id });
    const descriptor = candidateDescriptor(source.model, record);
    if (action === 'approve') {
      const conflicts = await RateCardItem.find({
        hospitalId,
        rateCardId: item.rateCardId,
        _id: { $ne: item._id },
        active: true,
        'internalService.model': descriptor.model,
        'internalService.id': descriptor.id,
        'internalService.mappingStatus': 'approved',
        'mappingOptions.allowMultipleExternalCodes': { $ne: true }
      }).select('externalCode externalName');
      if (conflicts.length && !allowMultipleExternalCodes) {
        const error = new Error(`Internal service is already approved for ${conflicts.map((row) => row.externalCode).join(', ')}`);
        error.statusCode = 409;
        error.conflicts = conflicts;
        throw error;
      }
    }
    item.internalService = {
      ...descriptor,
      confidence: source.confidence,
      rationale: rationale || source.rationale,
      suggestedBy: source.suggestedBy || 'user',
      suggestedAt: source.suggestedAt || now,
      mappingStatus: action === 'suggest' ? 'suggested' : action === 'review' ? 'reviewed' : 'approved',
      reviewedBy: ['review', 'approve'].includes(action) ? userId : undefined,
      reviewedAt: ['review', 'approve'].includes(action) ? now : undefined,
      approvedBy: action === 'approve' ? userId : undefined,
      approvedAt: action === 'approve' ? now : undefined
    };
    item.mappingOptions = {
      ...(item.mappingOptions?.toObject?.() || item.mappingOptions || {}),
      allowMultipleExternalCodes: Boolean(allowMultipleExternalCodes),
      requiredForBilling: requiredForBilling !== false,
      unavailableAtHospital: false,
      note: rationale
    };
  }
  await item.save({ validateBeforeSave: false });
  return item;
}

async function mappingCoverage({ hospitalId, rateCardId }) {
  const rows = await RateCardItem.aggregate([
    { $match: { hospitalId: new mongoose.Types.ObjectId(String(hospitalId)), rateCardId: new mongoose.Types.ObjectId(String(rateCardId)), active: true } },
    { $group: { _id: { serviceType: '$serviceType', status: '$internalService.mappingStatus' }, count: { $sum: 1 } } },
    { $sort: { '_id.serviceType': 1, '_id.status': 1 } }
  ]);
  const requiredItems = await RateCardItem.find({ hospitalId, rateCardId, active: true, 'mappingOptions.requiredForBilling': { $ne: false } }).select('internalService.mappingStatus').lean();
  const total = requiredItems.length;
  const approved = requiredItems.filter((row) => row.internalService?.mappingStatus === 'approved').length;
  const unavailable = await RateCardItem.countDocuments({ hospitalId, rateCardId, active: true, 'mappingOptions.unavailableAtHospital': true });
  return { total, approved, unavailable, coveragePercentage: total ? Number((approved / total * 100).toFixed(2)) : 100, breakdown: rows };
}

module.exports = { normalize, tokens, jaccard, similarity, modelCandidates, suggestMappings, reviewMapping, mappingCoverage };
