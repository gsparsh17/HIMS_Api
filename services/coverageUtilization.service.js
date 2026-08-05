const CoverageUtilization = require('../models/CoverageUtilization');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const { pricingSnapshot } = require('./pricingEngine.service');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sourceKey(sourceType, sourceId, sourceLineId) {
  return `${String(sourceType)}:${String(sourceId)}:${sourceLineId ? String(sourceLineId) : 'root'}`;
}

function allocation(quote = {}) {
  return {
    eligibleAmount: money(quote.amounts?.eligible),
    sponsorLiability: money(quote.amounts?.sponsorLiability),
    patientLiability: money(quote.amounts?.patientLiability),
    coPayAmount: money(quote.amounts?.coPay),
    deductibleAmount: money(quote.amounts?.deductible),
    fixedPatientShare: money(quote.amounts?.fixedPatientShare),
    uncoveredAmount: money(quote.amounts?.uncovered)
  };
}

function delta(after, before) {
  const result = {};
  Object.keys(after).forEach((key) => { result[key] = money(Number(after[key] || 0) - Number(before?.[key] || 0)); });
  return result;
}

function coverageIncrements(changes) {
  return {
    'beneficiary.coverageLimitUsed': money(changes.sponsorLiability),
    'beneficiary.deductibleUsed': money(changes.deductibleAmount),
    'preAuthorisation.consumedAmount': money(changes.sponsorLiability)
  };
}

async function adjustCoverage(coverageId, hospitalId, changes, session) {
  const increments = coverageIncrements(changes);
  if (Object.values(increments).every((value) => Math.abs(value) < 0.005)) return;
  await AdmissionCoverage.updateOne(
    { _id: coverageId, hospitalId },
    { $inc: increments },
    session ? { session } : undefined
  );
}

async function replaceCoverageUtilization({
  coverage,
  quote,
  hospitalId,
  encounterType,
  admissionId,
  appointmentId,
  patientId,
  sourceType,
  sourceId,
  sourceLineId,
  internalServiceModel,
  internalServiceId,
  userId,
  reason,
  session
}) {
  const coverageId = coverage?._id || quote?.inputs?.coverageId;
  if (!coverageId || !sourceId || !sourceType) return null;
  const type = String(encounterType || (admissionId ? 'IPD' : 'OPD')).toUpperCase();
  const key = sourceKey(sourceType, sourceId, sourceLineId);
  const nextAmounts = allocation(quote);
  const existing = await CoverageUtilization.findOne({ hospitalId, sourceKey: key }).session(session || null);
  const priorAmounts = existing?.status === 'active' ? existing.amounts?.toObject?.() || existing.amounts || {} : {};
  const changes = delta(nextAmounts, priorAmounts);

  if (existing) {
    const previousCoverageId = existing.coverageId;
    const coverageChanged = String(previousCoverageId) !== String(coverageId);
    existing.coverageId = coverageId;
    existing.encounterType = type;
    existing.admissionId = admissionId;
    existing.appointmentId = appointmentId;
    existing.patientId = patientId;
    existing.sourceLineId = sourceLineId;
    existing.serviceCode = quote?.serviceCode;
    existing.rateCardId = quote?.rateCard?.id;
    existing.rateCardItemId = quote?.rateCardItemId;
    existing.amounts = nextAmounts;
    existing.status = 'active';
    existing.pricingSnapshot = pricingSnapshot(quote, { internalServiceModel, internalServiceId });
    existing.recordedBy = userId;
    existing.reversedAt = undefined;
    existing.reversedBy = undefined;
    existing.reversalReason = undefined;
    await existing.save({ session });
    if (coverageChanged && priorAmounts) {
      const reversePrior = Object.fromEntries(Object.entries(priorAmounts).map(([keyName, value]) => [keyName, money(-Number(value || 0))]));
      await adjustCoverage(previousCoverageId, hospitalId, reversePrior, session);
      await adjustCoverage(coverageId, hospitalId, nextAmounts, session);
    } else {
      await adjustCoverage(coverageId, hospitalId, changes, session);
    }
    return existing;
  }

  let document;
  try {
    [document] = await CoverageUtilization.create([{
      hospitalId,
      coverageId,
      encounterType: type,
      admissionId,
      appointmentId,
      patientId,
      sourceType,
      sourceId,
      sourceLineId,
      sourceKey: key,
      serviceCode: quote?.serviceCode,
      rateCardId: quote?.rateCard?.id,
      rateCardItemId: quote?.rateCardItemId,
      amounts: nextAmounts,
      pricingSnapshot: pricingSnapshot(quote, { internalServiceModel, internalServiceId }),
      recordedBy: userId,
      reversalReason: reason
    }], { session });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return replaceCoverageUtilization({ coverage, quote, hospitalId, encounterType: type, admissionId, appointmentId, patientId, sourceType, sourceId, sourceLineId, internalServiceModel, internalServiceId, userId, reason, session });
  }
  await adjustCoverage(coverageId, hospitalId, nextAmounts, session);
  return document;
}

async function reverseCoverageUtilization({ hospitalId, sourceType, sourceId, sourceLineId, userId, reason, session }) {
  const key = sourceKey(sourceType, sourceId, sourceLineId);
  const existing = await CoverageUtilization.findOne({ hospitalId, sourceKey: key, status: 'active' }).session(session || null);
  if (!existing) return null;
  const before = existing.amounts?.toObject?.() || existing.amounts || {};
  const changes = Object.fromEntries(Object.entries(before).map(([keyName, value]) => [keyName, money(-Number(value || 0))]));
  existing.status = 'reversed';
  existing.reversedAt = new Date();
  existing.reversedBy = userId;
  existing.reversalReason = reason || 'Source charge reversed';
  await existing.save({ session });
  await adjustCoverage(existing.coverageId, hospitalId, changes, session);
  return existing;
}

module.exports = {
  money,
  sourceKey,
  allocation,
  replaceCoverageUtilization,
  reverseCoverageUtilization
};
