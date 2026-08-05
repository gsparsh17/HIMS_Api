const PackageEpisode = require('../models/PackageEpisode');
const RateCardItem = require('../models/RateCardItem');

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function id(value) {
  return value ? String(value._id || value) : '';
}

function componentMatches(component, input) {
  if (!component) return false;
  if (component.internalServiceId && id(component.internalServiceId) !== id(input.internalServiceId)) return false;
  if (component.model && normalized(component.model) !== normalized(input.internalServiceModel)) return false;
  if (component.internalCode && normalized(component.internalCode) !== normalized(input.internalCode || input.serviceCode || input.externalCode)) return false;
  if (component.serviceType && normalized(component.serviceType) !== normalized(input.serviceType)) return false;
  if (component.category && normalized(component.category) !== normalized(input.category)) return false;
  if (component.namePattern) {
    try {
      if (!new RegExp(component.namePattern, 'i').test(String(input.description || input.name || ''))) return false;
    } catch (_error) {
      return false;
    }
  }
  return Boolean(component.internalServiceId || component.model || component.internalCode || component.serviceType || component.category || component.namePattern);
}

function countUtilization(episode, component, input) {
  return (episode.utilization || []).filter((row) =>
    row.decision === 'included' &&
    !row.reversedAt &&
    (!component.internalServiceId || id(row.internalServiceId) === id(input.internalServiceId)) &&
    (!component.internalCode || normalized(row.internalCode) === normalized(input.internalCode || input.serviceCode)) &&
    (!component.serviceType || normalized(row.serviceType) === normalized(input.serviceType))
  );
}

function componentDecision(episode, component, input) {
  const existing = countUtilization(episode, component, input);
  const quantityUsed = existing.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const amountUsed = existing.reduce((sum, row) => sum + Number(row.absorbedAmount || 0), 0);
  if (component.quantityLimit !== undefined && component.quantityLimit !== null && quantityUsed + Number(input.quantity || 1) > Number(component.quantityLimit)) {
    return { decision: 'limit_exceeded', component, quantityUsed, amountUsed };
  }
  if (component.amountLimit !== undefined && component.amountLimit !== null && amountUsed + Number(input.standardAmount || 0) > Number(component.amountLimit)) {
    return { decision: 'limit_exceeded', component, quantityUsed, amountUsed };
  }
  return { decision: 'included', component, quantityUsed, amountUsed };
}

async function findActivePackageDecision(input) {
  if (!input.coverage?._id) return null;
  const serviceDate = new Date(input.serviceDate || Date.now());
  const filter = {
    hospitalId: input.hospitalId,
    coverageId: input.coverage._id,
    status: 'active',
    startsAt: { $lte: serviceDate },
    endsAt: { $gte: serviceDate }
  };
  const episodes = await PackageEpisode.find(filter).sort({ startsAt: -1, createdAt: -1 });
  for (const episode of episodes) {
    const snapshot = episode.packageSnapshot || {};
    const definition = snapshot.packageDefinition || {};
    const exclusion = (definition.exclusions || []).find((row) => componentMatches(row, input));
    if (exclusion) return { episode, decision: 'excluded', component: exclusion, reason: 'Matched package exclusion' };
    const inclusion = (definition.inclusions || []).find((row) => componentMatches(row, input));
    if (inclusion) return { episode, ...componentDecision(episode, inclusion, input), reason: 'Matched package inclusion' };

    const type = normalized(input.serviceType);
    const includedByFlag =
      (type === 'pharmacy' && definition.includesMedicines) ||
      (['consumable', 'consumables', 'inventory', 'implant'].includes(type) && definition.includesConsumables) ||
      (['laboratory', 'radiology'].includes(type) && definition.includesInvestigations) ||
      (type === 'bed' && definition.includesRoom) ||
      (['consultation', 'procedure'].includes(type) && definition.includesProfessionalFees);
    if (includedByFlag) return { episode, decision: 'included', component: { componentType: 'service_type', serviceType: type }, reason: 'Included by package category flag' };

    const fallback = definition.defaultUnlistedComponentTreatment || 'excluded';
    if (fallback === 'included') return { episode, decision: 'included', component: { componentType: 'other' }, reason: 'Package default includes unlisted components' };
    if (fallback === 'excluded') return { episode, decision: 'excluded', component: { componentType: 'other' }, reason: 'Package default excludes unlisted components' };
    if (fallback === 'cash_fallback') return { episode, decision: 'cash_fallback', component: { componentType: 'other' }, reason: 'Package default sends unlisted components to cash billing' };
    if (fallback === 'payer_rate') return { episode, decision: 'payer_rate', component: { componentType: 'other' }, reason: 'Package default sends unlisted components to the payer tariff' };
  }
  return null;
}

async function activatePackageEpisode({ quote, coverage, hospitalId, encounterType, encounterId, patientId, sourceType, sourceId, sourceLineId, userId, session }) {
  if (!quote?.rateCardItemId || !quote?.packageCode) return null;
  const item = await RateCardItem.findOne({ _id: quote.rateCardItemId, hospitalId }).session(session || null);
  if (!item?.packageDefinition?.isPackage) return null;
  const existingFilter = {
    hospitalId,
    coverageId: coverage._id,
    triggerSourceType: sourceType,
    triggerSourceId: sourceId,
    triggerSourceLineId: sourceLineId,
    rateCardItemId: item._id
  };
  if (sourceLineId) existingFilter.triggerSourceLineId = sourceLineId;
  else existingFilter.triggerSourceLineId = { $exists: false };
  const existing = await PackageEpisode.findOne(existingFilter).session(session || null);
  if (existing) return existing;

  const days = Math.max(0, Number(item.packagePeriodDays || 0));
  const startsAt = item.packageDefinition?.startsAt === 'admission_time'
    ? new Date(coverage.effectiveFrom || quote.inputs?.serviceDate || Date.now())
    : new Date(quote.inputs?.serviceDate || Date.now());
  const endsAt = new Date(startsAt.getTime() + Math.max(1, days || 1) * 86400000 - 1);
  const document = {
    hospitalId,
    coverageId: coverage._id,
    encounterType,
    patientId,
    payerId: coverage.payerId?._id || coverage.payerId,
    rateCardId: quote.rateCard.id,
    rateCardItemId: item._id,
    packageCode: item.externalCode,
    packageName: item.externalName,
    triggerSourceType: sourceType,
    triggerSourceId: sourceId,
    triggerSourceLineId: sourceLineId,
    startsAt,
    endsAt,
    contractedAmount: quote.amounts.contracted,
    approvedAmountCap: coverage.preAuthorisation?.approvedAmount,
    packageSnapshot: item.toObject(),
    createdBy: userId,
    updatedBy: userId
  };
  if (encounterType === 'IPD') document.admissionId = encounterId;
  else document.appointmentId = encounterId;
  const [episode] = await PackageEpisode.create([document], { session });
  return episode;
}

async function recordPackageUtilization({ decision, input, quote, sourceType, sourceId, sourceLineId, session }) {
  if (!decision?.episode || !['included', 'excluded', 'limit_exceeded'].includes(decision.decision)) return null;
  const episode = await PackageEpisode.findById(decision.episode._id).session(session || null);
  if (!episode) return null;
  const duplicate = (episode.utilization || []).find((row) =>
    !row.reversedAt &&
    String(row.sourceType) === String(sourceType) &&
    String(row.sourceId) === String(sourceId) &&
    String(row.sourceLineId || '') === String(sourceLineId || '')
  );
  if (duplicate) return episode;
  episode.utilization.push({
    sourceType,
    sourceId,
    sourceLineId,
    serviceType: input.serviceType,
    internalServiceModel: input.internalServiceModel,
    internalServiceId: input.internalServiceId,
    internalCode: input.internalCode || input.serviceCode || input.externalCode,
    description: input.description || input.name,
    quantity: input.quantity || 1,
    standardAmount: quote.amounts.hospitalStandard,
    absorbedAmount: quote.amounts.packageAbsorbed || 0,
    patientAmount: quote.amounts.patientLiability || 0,
    sponsorAmount: quote.amounts.sponsorLiability || 0,
    decision: decision.decision,
    rule: decision.component
  });
  episode.totals.standardConsumed = Number(episode.totals?.standardConsumed || 0) + Number(quote.amounts.hospitalStandard || 0);
  episode.totals.absorbed = Number(episode.totals?.absorbed || 0) + Number(quote.amounts.packageAbsorbed || 0);
  episode.totals.separatelyBillablePatient = Number(episode.totals?.separatelyBillablePatient || 0) + Number(quote.amounts.patientLiability || 0);
  episode.totals.separatelyBillableSponsor = Number(episode.totals?.separatelyBillableSponsor || 0) + Number(quote.amounts.sponsorLiability || 0);
  episode.revision += 1;
  await episode.save({ session });
  return episode;
}

async function reversePackageUtilization({ hospitalId, sourceType, sourceId, sourceLineId, userId, reason, session }) {
  const episodes = await PackageEpisode.find({
    hospitalId,
    utilization: {
      $elemMatch: {
        sourceType,
        sourceId,
        ...(sourceLineId ? { sourceLineId } : {}),
        reversedAt: { $exists: false }
      }
    }
  }).session(session || null);
  for (const episode of episodes) {
    for (const row of episode.utilization || []) {
      if (row.reversedAt) continue;
      if (String(row.sourceType) !== String(sourceType) || String(row.sourceId) !== String(sourceId)) continue;
      if (sourceLineId && String(row.sourceLineId || '') !== String(sourceLineId)) continue;
      row.reversedAt = new Date();
      row.reversedBy = userId;
      row.reversalReason = reason || 'Source line reversed or repriced';
      episode.totals.standardConsumed = Math.max(0, Number(episode.totals?.standardConsumed || 0) - Number(row.standardAmount || 0));
      episode.totals.absorbed = Math.max(0, Number(episode.totals?.absorbed || 0) - Number(row.absorbedAmount || 0));
      episode.totals.separatelyBillablePatient = Math.max(0, Number(episode.totals?.separatelyBillablePatient || 0) - Number(row.patientAmount || 0));
      episode.totals.separatelyBillableSponsor = Math.max(0, Number(episode.totals?.separatelyBillableSponsor || 0) - Number(row.sponsorAmount || 0));
    }
    episode.revision += 1;
    episode.updatedBy = userId;
    await episode.save({ session });
  }
  return episodes;
}

module.exports = {
  componentMatches,
  findActivePackageDecision,
  activatePackageEpisode,
  recordPackageUtilization,
  reversePackageUtilization
};
