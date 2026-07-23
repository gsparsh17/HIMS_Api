const RateCardItem = require('../models/RateCardItem');
const { activeCoverage, resolveEffectiveRateCard } = require('./coverage.service');
const { roundMoney, applyConfiguredRateRules } = require('./pricingRules.service');

function round(value, mode = 'two_decimals') { return roundMoney(value, mode); }


function mapValue(map, key, fallback = 1) {
  if (!map) return fallback;
  if (typeof map.get === 'function') return Number(map.get(key) ?? fallback);
  return Number(map[key] ?? fallback);
}

function tierRate(item, tier, accreditation) {
  if (item.rates?.flatAmount !== undefined && item.rates?.flatAmount !== null) return Number(item.rates.flatAmount);
  const tierKey = tier === 'II' ? 'tierII' : tier === 'III' ? 'tierIII' : 'tierI';
  const accreditationKey = accreditation === 'non_nabh_non_nabl' ? 'nonNabh' : accreditation === 'super_speciality' ? 'superSpeciality' : 'nabh';
  return Number(item.rates?.[tierKey]?.[accreditationKey] ?? item.rates?.[tierKey]?.nabh ?? 0);
}

function serviceTypeFromCharge(chargeType) {
  const value = String(chargeType || '').toLowerCase();
  if (value.includes('lab')) return 'laboratory';
  if (value.includes('radiology') || value.includes('imaging')) return 'radiology';
  if (value.includes('bed')) return 'bed';
  if (value.includes('surgery') || value.includes('procedure')) return 'procedure';
  if (value.includes('consult') || value.includes('doctor')) return 'consultation';
  if (value.includes('pharmacy') || value.includes('medicine')) return 'pharmacy';
  if (value.includes('equipment')) return 'equipment';
  return 'other';
}

async function findItem({ hospitalId, rateCardId, externalCode, internalServiceModel, internalServiceId, serviceType }) {
  const match = { hospitalId, rateCardId, active: true };
  if (externalCode) match.externalCode = String(externalCode).toUpperCase();
  else if (internalServiceModel && internalServiceId) {
    match['internalService.model'] = internalServiceModel;
    match['internalService.id'] = internalServiceId;
    match['internalService.mappingStatus'] = 'approved';
  } else {
    return null;
  }
  return RateCardItem.findOne(match);
}

async function quotePricing(input) {
  const serviceDate = input.serviceDate ? new Date(input.serviceDate) : new Date();
  const quantity = Math.max(1, Number(input.quantity || 1));
  const standardAmount = Number(input.standardAmount ?? input.rate ?? 0) * quantity;
  const coverage = input.coverage || (input.admissionId ? await activeCoverage(input.hospitalId, input.admissionId) : null);

  if (!coverage || coverage.payerCategory === 'self') {
    return {
      serviceCode: input.externalCode || input.serviceCode || null,
      rateCard: null,
      inputs: { payer: 'SELF', serviceDate, quantity },
      amounts: { hospitalStandard: round(standardAmount), contracted: round(standardAmount), sponsorLiability: 0, patientLiability: round(standardAmount), nonAdmissible: 0, hospitalAdjustment: 0 },
      explanation: ['Standard hospital rate selected', 'Self-pay admission'],
      ruleTrace: []
    };
  }

  const rateCard = coverage.rateCardId
    ? coverage.rateCardId.rules ? coverage.rateCardId : await resolveEffectiveRateCard({ hospitalId: input.hospitalId, payerId: coverage.payerId?._id || coverage.payerId, serviceDate, explicitRateCardId: coverage.rateCardId?._id || coverage.rateCardId })
    : await resolveEffectiveRateCard({ hospitalId: input.hospitalId, payerId: coverage.payerId?._id || coverage.payerId, serviceDate });
  if (!rateCard) {
    const error = new Error('No effective rate card found for this coverage');
    error.statusCode = 409;
    throw error;
  }

  const serviceType = input.serviceType || serviceTypeFromCharge(input.chargeType);
  const item = await findItem({
    hospitalId: input.hospitalId,
    rateCardId: rateCard._id,
    externalCode: input.externalCode || input.serviceCode,
    internalServiceModel: input.internalServiceModel,
    internalServiceId: input.internalServiceId,
    serviceType
  });
  if (!item) {
    const error = new Error('Service is not mapped to the selected payer rate card');
    error.statusCode = 422;
    throw error;
  }

  const cityTier = input.cityTier || coverage.rateContext?.cityTier || 'I';
  const accreditation = input.accreditation || coverage.rateContext?.accreditation || 'nabh_nabl';
  const wardEntitlement = input.wardEntitlement || coverage.beneficiary?.wardEntitlement || 'semi_private';
  const rules = rateCard.rules || {};
  const applied = applyConfiguredRateRules({ item, rules, cityTier, accreditation, wardEntitlement, sameOtSessionIndex: input.sameOtSessionIndex || 1, bilateralSecond: input.bilateralSecond === true, withinPackagePeriod: input.withinPackagePeriod === true });
  const { contractedUnit, explanation, ruleTrace } = applied;

  const contracted = round(contractedUnit * quantity, rules.rounding);
  const coPayPercentage = Number(input.coPayPercentage ?? coverage.beneficiary?.coPayPercentage ?? 0);
  const deductibleRemaining = Number(input.deductibleRemaining ?? coverage.beneficiary?.deductibleAmount ?? 0);
  const nonAdmissible = round(Number(input.nonAdmissibleAmount || 0), rules.rounding);
  const coPay = round(contracted * coPayPercentage / 100, rules.rounding);
  const deductible = round(Math.min(Math.max(0, contracted - nonAdmissible - coPay), deductibleRemaining), rules.rounding);
  const patientLiability = round(coPay + deductible + nonAdmissible, rules.rounding);
  const sponsorLiability = round(Math.max(0, contracted - patientLiability), rules.rounding);
  const hospitalAdjustment = round(standardAmount - contracted, rules.rounding);

  return {
    serviceCode: item.externalCode,
    rateCard: { id: rateCard._id, version: rateCard.version, name: rateCard.name },
    rateCardItemId: item._id,
    packageCode: item.externalCode,
    packagePeriodDays: item.packagePeriodDays,
    inputs: {
      payer: coverage.payerId?.code || coverage.payerId?.name || String(coverage.payerId),
      coverageId: coverage._id,
      cityTier,
      accreditation,
      wardEntitlement,
      serviceDate,
      quantity,
      sameOtSessionIndex: input.sameOtSessionIndex || 1,
      bilateralSecond: Boolean(input.bilateralSecond),
      withinPackagePeriod: Boolean(input.withinPackagePeriod),
      coPayPercentage,
      deductibleRemaining
    },
    amounts: { hospitalStandard: round(standardAmount), contracted, sponsorLiability, patientLiability, nonAdmissible, hospitalAdjustment },
    explanation,
    ruleTrace
  };
}

module.exports = { quotePricing, serviceTypeFromCharge, round };
