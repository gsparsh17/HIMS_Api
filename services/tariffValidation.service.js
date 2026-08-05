const mongoose = require('mongoose');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');

const VALIDATION_VERSION = 'insurance-tariff-v2';

function moneyValues(item) {
  const values = [];
  const rates = item.rates || {};
  ['tierI', 'tierII', 'tierIII'].forEach((tier) => {
    ['nonNabh', 'nabh', 'superSpeciality'].forEach((level) => {
      const value = rates?.[tier]?.[level];
      if (value !== undefined && value !== null && value !== '') values.push(Number(value));
    });
  });
  if (rates.flatAmount !== undefined && rates.flatAmount !== null) values.push(Number(rates.flatAmount));
  Object.values(rates.exactWard || {}).forEach((value) => {
    if (value !== undefined && value !== null && value !== '') values.push(Number(value));
  });
  return values;
}

function itemIssues(item) {
  const issues = [];
  const name = String(item.externalName || '').trim();
  const code = String(item.externalCode || '').trim();
  if (!code) issues.push({ code: 'BLANK_CODE', severity: 'error', message: 'External code is blank' });
  if (!name) issues.push({ code: 'BLANK_NAME', severity: 'error', message: 'External service name is blank' });
  // A migration may insert an explicit placeholder so the document remains
  // editable, but that must never be treated as a repaired source name.
  if (item.sourceRow?.raw?.sourceNameMissing) {
    issues.push({
      code: 'SOURCE_NAME_UNRESOLVED',
      severity: 'error',
      message: 'The official source name is still missing; replace the placeholder from the verified tariff source'
    });
  }
  if (!item.serviceType) issues.push({ code: 'SERVICE_TYPE_REQUIRED', severity: 'error', message: 'Service type is required' });

  const values = moneyValues(item);
  if (item.pricingMode !== 'non_admissible' && values.length === 0) {
    issues.push({ code: 'RATE_REQUIRED', severity: 'error', message: 'No tariff amount is configured' });
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    issues.push({ code: 'INVALID_RATE', severity: 'error', message: 'Tariff amounts must be non-negative numbers' });
  }
  if (item.pricingMode === 'flat' && !Number.isFinite(Number(item.rates?.flatAmount))) {
    issues.push({ code: 'FLAT_RATE_REQUIRED', severity: 'error', message: 'Flat pricing requires rates.flatAmount' });
  }
  if (item.pricingMode === 'exact_ward' && Object.values(item.rates?.exactWard || {}).filter((value) => value !== null && value !== undefined).length === 0) {
    issues.push({ code: 'WARD_RATE_REQUIRED', severity: 'error', message: 'Exact-ward pricing requires at least one ward amount' });
  }
  if (item.packageDefinition?.isPackage && !item.packagePeriodDays) {
    issues.push({ code: 'PACKAGE_PERIOD_MISSING', severity: 'warning', message: 'Package has no package period' });
  }
  if (item.packageDefinition?.isPackage) {
    const packageHasRules = Boolean(
      item.packageDefinition.includesMedicines || item.packageDefinition.includesConsumables ||
      item.packageDefinition.includesInvestigations || item.packageDefinition.includesRoom ||
      item.packageDefinition.includesProfessionalFees ||
      item.packageDefinition.inclusions?.length || item.packageDefinition.exclusions?.length
    );
    if (!packageHasRules) issues.push({ code: 'PACKAGE_SCOPE_EMPTY', severity: 'warning', message: 'Package inclusions and exclusions are not defined' });
  }
  if (!item.sourceRow?.page && !item.sourceRow?.sheet && !item.sourceRow?.annexure) {
    issues.push({ code: 'SOURCE_TRACEABILITY_MISSING', severity: 'error', message: 'Source page, sheet or annexure is required' });
  }
  if (item.active && item.mappingOptions?.requiredForBilling !== false && item.internalService?.mappingStatus !== 'approved') {
    issues.push({ code: 'MAPPING_NOT_APPROVED', severity: 'info', message: 'Required internal service mapping is not approved' });
  }
  return issues;
}

function aggregateIssues(items) {
  const codeCounts = new Map();
  const pageCounts = new Map();
  const mappingCounts = new Map();
  items.forEach((item) => {
    const code = String(item.externalCode || '').trim().toUpperCase();
    codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
    if (item.sourceRow?.page) pageCounts.set(String(item.sourceRow.page), (pageCounts.get(String(item.sourceRow.page)) || 0) + 1);
    if (item.active && item.internalService?.mappingStatus === 'approved' && item.internalService?.model && item.internalService?.id) {
      const key = `${item.internalService.model}:${item.internalService.id}`;
      const rows = mappingCounts.get(key) || [];
      rows.push(item);
      mappingCounts.set(key, rows);
    }
  });

  const extra = new Map();
  items.forEach((item) => extra.set(String(item._id), []));
  items.forEach((item) => {
    const code = String(item.externalCode || '').trim().toUpperCase();
    if (code && codeCounts.get(code) > 1) extra.get(String(item._id)).push({ code: 'DUPLICATE_EXTERNAL_CODE', severity: 'error', message: `External code ${code} is duplicated` });
  });
  mappingCounts.forEach((rows) => {
    if (rows.length <= 1 || rows.every((row) => row.mappingOptions?.allowMultipleExternalCodes)) return;
    rows.forEach((row) => extra.get(String(row._id)).push({
      code: 'CONFLICTING_INTERNAL_MAPPING', severity: 'error',
      message: `${rows.length} active tariff items map to the same internal service; explicitly allow multiple external codes or resolve the conflict`
    }));
  });

  // A large PDF catalogue claiming every item is on one source page is not auditable.
  if (items.length > 100 && pageCounts.size === 1) {
    items.forEach((item) => extra.get(String(item._id)).push({
      code: 'SOURCE_PAGE_SUSPICIOUS', severity: 'error',
      message: `All ${items.length} items use the same source page; genuine row-level traceability must be restored`
    }));
  }
  return extra;
}


function applyPreviewMutations(items, previewMutations = {}) {
  const annexure = String(previewMutations.inheritedAnnexure || '').trim();
  const verifiedNames = previewMutations.verifiedNames instanceof Map
    ? previewMutations.verifiedNames
    : new Map(Object.entries(previewMutations.verifiedNames || {}).map(([code, name]) => [String(code).trim().toUpperCase(), String(name).trim()]));
  const legacyRatesById = previewMutations.legacyRatesById instanceof Map
    ? previewMutations.legacyRatesById
    : new Map(Object.entries(previewMutations.legacyRatesById || {}));

  for (const item of items) {
    if (annexure && !item.sourceRow?.page && !item.sourceRow?.sheet && !item.sourceRow?.annexure) {
      item.sourceRow = {
        ...(item.sourceRow?.toObject?.() || item.sourceRow || {}),
        annexure,
        raw: {
          ...(item.sourceRow?.raw || {}),
          sourceReferenceInheritedFromRateCard: true
        }
      };
    }
    const verifiedName = verifiedNames.get(String(item.externalCode || '').trim().toUpperCase());
    if (verifiedName) {
      item.externalName = verifiedName;
      item.sourceRow = {
        ...(item.sourceRow?.toObject?.() || item.sourceRow || {}),
        raw: {
          ...(item.sourceRow?.raw || {}),
          sourceNameMissing: false,
          sourceNameVerified: true
        }
      };
    }
    const rateMutation = legacyRatesById.get(String(item._id));
    if (rateMutation) {
      item.pricingMode = rateMutation.pricingMode;
      item.rates = rateMutation.rates;
    }
  }
  return items;
}

async function validateRateCard({ hospitalId, rateCardId, persist = true, previewMutations }) {
  const card = await RateCard.findOne({ _id: rateCardId, hospitalId });
  if (!card) {
    const error = new Error('Rate card not found');
    error.statusCode = 404;
    throw error;
  }
  const items = await RateCardItem.find({ hospitalId, rateCardId: card._id }).sort({ externalCode: 1 });
  if (!persist && previewMutations) applyPreviewMutations(items, previewMutations);
  const extra = aggregateIssues(items);
  const allIssues = [];
  let blankNames = 0;
  let duplicateCodes = 0;
  let invalidRates = 0;
  let unmappedItems = 0;
  let approvedMappings = 0;
  let requiredMappings = 0;
  let unavailableItems = 0;
  let sourceTraceabilityErrors = 0;

  for (const item of items) {
    const issues = [...itemIssues(item), ...(extra.get(String(item._id)) || [])];
    issues.forEach((issue) => {
      if (issue.code === 'BLANK_NAME') blankNames += 1;
      if (issue.code === 'DUPLICATE_EXTERNAL_CODE') duplicateCodes += 1;
      if (['INVALID_RATE', 'RATE_REQUIRED', 'FLAT_RATE_REQUIRED', 'WARD_RATE_REQUIRED'].includes(issue.code)) invalidRates += 1;
      if (['SOURCE_TRACEABILITY_MISSING', 'SOURCE_PAGE_SUSPICIOUS'].includes(issue.code)) sourceTraceabilityErrors += 1;
      allIssues.push({ ...issue, itemId: item._id, externalCode: item.externalCode });
    });
    const mappingRequired = item.active && item.mappingOptions?.requiredForBilling !== false;
    if (mappingRequired) requiredMappings += 1;
    if (mappingRequired && item.internalService?.mappingStatus !== 'approved') unmappedItems += 1;
    if (mappingRequired && item.internalService?.mappingStatus === 'approved') approvedMappings += 1;
    if (item.active && item.mappingOptions?.unavailableAtHospital) unavailableItems += 1;
    if (persist) {
      item.validation = {
        status: issues.some((issue) => issue.severity === 'error')
          ? 'invalid'
          : issues.some((issue) => issue.severity === 'warning')
            ? 'warning'
            : issues.some((issue) => issue.severity === 'info')
              ? 'pending'
              : 'valid',
        issues,
        validatedAt: new Date()
      };
      await item.save({ validateBeforeSave: false });
    }
  }

  const criticalErrors = allIssues.filter((issue) => issue.severity === 'error').length;
  const warnings = allIssues.filter((issue) => issue.severity === 'warning').length;
  const informational = allIssues.filter((issue) => issue.severity === 'info').length;
  const mappingPending = allIssues.filter((issue) => issue.code === 'MAPPING_NOT_APPROVED').length;
  const packageScopePending = allIssues.filter((issue) => issue.code === 'PACKAGE_SCOPE_EMPTY').length;
  const unresolvedSourceNames = allIssues.filter((issue) => issue.code === 'SOURCE_NAME_UNRESOLVED').length;
  const issueSummaryMap = new Map();
  for (const issue of allIssues) {
    const key = `${issue.severity}:${issue.code}:${issue.message}`;
    const row = issueSummaryMap.get(key) || {
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      count: 0
    };
    row.count += 1;
    issueSummaryMap.set(key, row);
  }
  const severityRank = { error: 0, warning: 1, info: 2 };
  const issueSummary = [...issueSummaryMap.values()].sort(
    (a, b) => (severityRank[a.severity] - severityRank[b.severity]) || (b.count - a.count) || a.code.localeCompare(b.code)
  );
  const sortedIssues = [...allIssues].sort(
    (a, b) => (severityRank[a.severity] - severityRank[b.severity]) || String(a.externalCode || '').localeCompare(String(b.externalCode || ''))
  );
  const mappingPercentage = requiredMappings ? (approvedMappings / requiredMappings) * 100 : 100;
  const quality = {
    lastValidatedAt: new Date(),
    validationVersion: VALIDATION_VERSION,
    criticalErrors,
    warnings,
    informational,
    blankNames,
    duplicateCodes,
    invalidRates,
    unmappedItems,
    approvedMappings,
    requiredMappings,
    unavailableItems,
    sourceTraceabilityErrors,
    mappingPending,
    packageScopePending,
    unresolvedSourceNames,
    activationReady: false,
    issueSummary,
    issues: sortedIssues.slice(0, 1000)
  };
  const gate = await activationGate({ card, hospitalId, quality, mappingPercentage });
  quality.activationReady = gate.ready;
  if (persist) {
    card.itemCount = items.length;
    card.quality = quality;
    card.revision = Number(card.revision || 0) + 1;
    await card.save({ validateBeforeSave: false });
  }
  return { card, quality, mappingPercentage: Number(mappingPercentage.toFixed(2)), gate, itemCount: items.length };
}

async function activationGate({ card, hospitalId, quality = card.quality || {}, mappingPercentage }) {
  const payer = await Payer.findOne({ _id: card.payerId, hospitalId });
  const reasons = [];
  if (!payer || !payer.isActive) reasons.push({ code: 'PAYER_INACTIVE', message: 'Payer must be active' });
  if (card.activationRequirements?.requireActiveEmpanelment && payer?.empanelment?.status !== 'active' && !card.demoOnly) {
    reasons.push({ code: 'EMPANELMENT_NOT_ACTIVE', message: 'Payer empanelment must be active' });
  }
  if (!card.approval?.firstApprovedBy) reasons.push({ code: 'FIRST_APPROVAL_REQUIRED', message: 'First approval is required' });
  if (!card.approval?.secondApprovedBy) reasons.push({ code: 'SECOND_APPROVAL_REQUIRED', message: 'Second approval is required' });
  if (card.approval?.firstApprovedBy && card.approval?.secondApprovedBy && String(card.approval.firstApprovedBy) === String(card.approval.secondApprovedBy)) {
    reasons.push({ code: 'SAME_APPROVER', message: 'First and second approval must be completed by different users' });
  }
  if (Number(quality.criticalErrors || 0) > 0) reasons.push({ code: 'QUALITY_ERRORS', message: `${quality.criticalErrors} critical tariff validation error(s) remain` });
  const requiredPercent = card.activationRequirements?.requireAllBillableMappings
    ? 100
    : Number(card.activationRequirements?.minimumApprovedMappingPercentage || 0);
  const percentage = mappingPercentage === undefined
    ? (Number(quality.requiredMappings || 0)
      ? Number(quality.approvedMappings || 0) / Number(quality.requiredMappings || 0) * 100
      : 100)
    : mappingPercentage;
  if (percentage + 1e-9 < requiredPercent) reasons.push({ code: 'MAPPING_COVERAGE_LOW', message: `Approved mapping coverage ${percentage.toFixed(2)}% is below required ${requiredPercent}%` });
  if (card.activationRequirements?.requireSourceVerification && !card.source?.verifiedAgainstSource) {
    reasons.push({ code: 'SOURCE_NOT_VERIFIED', message: 'Rate card source must be verified against the original document' });
  }
  if (!card.itemCount) reasons.push({ code: 'EMPTY_RATE_CARD', message: 'Rate card contains no items' });
  return { ready: reasons.length === 0, reasons, payer, mappingPercentage: Number(percentage.toFixed(2)) };
}

module.exports = {
  VALIDATION_VERSION,
  moneyValues,
  itemIssues,
  aggregateIssues,
  applyPreviewMutations,
  validateRateCard,
  activationGate
};
