const RateCardItem = require('../models/RateCardItem');
const Payer = require('../models/Payer');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Bed = require('../models/Bed');
const BillingServiceMaster = require('../models/BillingServiceMaster');
const { activeCoverage, activeAppointmentCoverage, resolveEffectiveRateCard } = require('./coverage.service');
const { roundMoney, applyConfiguredRateRules } = require('./pricingRules.service');
const { findActivePackageDecision } = require('./packageAdjudication.service');

// ============================================
// Helpers
// ============================================

function round(value, mode = 'two_decimals') {
  return roundMoney(value, mode);
}

function httpError(message, statusCode = 400, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;

  if (code) {
    error.code = code;
  }

  if (details) {
    error.details = details;
  }

  return error;
}

function serviceTypeFromCharge(chargeType) {
  const value = String(chargeType || '').toLowerCase();

  if (value.includes('lab')) return 'laboratory';
  if (value.includes('radiology') || value.includes('imaging')) return 'radiology';
  if (value.includes('bed') || value.includes('room')) return 'bed';
  if (value.includes('surgery') || value.includes('procedure')) return 'procedure';
  if (value.includes('consult') || value.includes('doctor')) return 'consultation';
  if (value.includes('pharmacy') || value.includes('medicine')) return 'pharmacy';
  if (value.includes('equipment')) return 'equipment';

  return 'other';
}

// ============================================
// Rate Card Item Lookup
// ============================================

async function findItem({
  hospitalId,
  rateCardId,
  externalCode,
  internalServiceModel,
  internalServiceId,
  serviceType,
  doctorId,
  encounterType,
  visitType,
  wardEntitlement,
}) {
  const base = { hospitalId, rateCardId, active: true };

  // Clinician tariffs are a first-class rate-card dimension. Prefer the most
  // specific doctor/encounter/visit/ward match and gracefully fall back to
  // ANY dimensions. This is deliberately separate from Doctor.amount payroll.
  if (doctorId) {
    const ctx = {
      ...base,
      serviceType: serviceType || 'consultation',
      'clinicianContext.doctorId': doctorId,
      'clinicianContext.encounterType': { $in: [String(encounterType || 'ANY').toUpperCase(), 'ANY'] },
      'clinicianContext.visitType': { $in: [String(visitType || 'ANY').toUpperCase(), 'ANY'] },
      'clinicianContext.wardEntitlement': { $in: [String(wardEntitlement || 'ANY') === 'ANY' ? 'ANY' : String(wardEntitlement).toLowerCase(), 'ANY'] },
    };
    if (externalCode) ctx.externalCode = String(externalCode).toUpperCase();

    const candidates = await RateCardItem.find(ctx).lean();
    if (candidates.length) {
      const wantedEncounter = String(encounterType || 'ANY').toUpperCase();
      const wantedVisit = String(visitType || 'ANY').toUpperCase();
      const wantedWard = String(wardEntitlement || 'ANY') === 'ANY' ? 'ANY' : String(wardEntitlement).toLowerCase();
      const score = (row) => {
        const c = row.clinicianContext || {};
        return (String(c.encounterType || 'ANY') === wantedEncounter ? 4 : 0)
          + (String(c.visitType || 'ANY') === wantedVisit ? 2 : 0)
          + (String(c.wardEntitlement || 'ANY') === wantedWard ? 1 : 0);
      };
      candidates.sort((a, b) => score(b) - score(a));
      return candidates[0];
    }
  }

  const match = { ...base };
  // A generic fallback must never accidentally pick a clinician-specific row
  // belonging to another doctor. Legacy/general rows either have no doctorId
  // or an explicitly null doctorId.
  if (doctorId) {
    match.$or = [
      { 'clinicianContext.doctorId': { $exists: false } },
      { 'clinicianContext.doctorId': null },
    ];
  }
  if (externalCode) {
    match.externalCode = String(externalCode).toUpperCase();
  } else if (internalServiceModel && internalServiceId) {
    match['internalService.model'] = internalServiceModel;
    match['internalService.id'] = internalServiceId;
    match['internalService.mappingStatus'] = 'approved';
  } else {
    return null;
  }

  return RateCardItem.findOne(match);
}

// ============================================
// Resolve Standard Unit
// ============================================

async function resolveStandardUnit(input) {
  if (input.standardAmount !== undefined && input.standardAmount !== null) {
    return Number(input.standardAmount);
  }

  if (input.rate !== undefined && input.rate !== null) {
    return Number(input.rate);
  }

  if (!input.internalServiceModel || !input.internalServiceId) {
    return 0;
  }

  const models = {
    LabTest: { Model: LabTest, field: 'base_price' },
    ImagingTest: { Model: ImagingTest, field: 'base_price' },
    Procedure: { Model: Procedure, field: 'base_price' },
    Bed: { Model: Bed, field: 'dailyCharge' },
    BillingServiceMaster: { Model: BillingServiceMaster, field: 'price' },
  };

  const config = models[input.internalServiceModel];

  if (!config) {
    return 0;
  }

  const row = await config.Model.findOne({
    _id: input.internalServiceId,
    hospitalId: input.hospitalId,
  }).lean();

  if (!row) {
    throw httpError('Hospital service master record not found', 404, 'SERVICE_MASTER_NOT_FOUND');
  }

  if (row.is_active === false || row.isActive === false || row.active === false) {
    throw httpError('Hospital service is inactive', 409, 'SERVICE_MASTER_INACTIVE');
  }

  if (row.is_billable === false || row.template_only === true) {
    throw httpError('Selected record is not a billable service', 409, 'SERVICE_NOT_BILLABLE');
  }

  return Number(row[config.field] || 0);
}

// ============================================
// Self Quote
// ============================================

function selfQuote(input, standardAmount, quantity, explanation = ['Standard hospital cash rate selected']) {
  const total = round(standardAmount * quantity);

  return {
    resultType: 'self',
    serviceCode: input.externalCode || input.serviceCode || input.internalCode || null,
    rateCard: null,
    inputs: {
      payer: 'SELF',
      serviceDate: new Date(input.serviceDate || Date.now()),
      quantity,
    },
    amounts: {
      hospitalStandard: total,
      contracted: total,
      eligible: total,
      sponsorLiability: 0,
      patientLiability: total,
      nonAdmissible: 0,
      hospitalAdjustment: 0,
      hospitalConcession: 0,
      packageAbsorbed: 0,
      coPay: 0,
      deductible: 0,
      fixedPatientShare: 0,
      uncovered: 0,
    },
    explanation,
    ruleTrace: [],
  };
}

// ============================================
// Missing Item Policy
// ============================================

function missingItemPolicy(rateCard, coverage, payer) {
  const fromCard = rateCard?.rules?.missingItemPolicy;

  if (fromCard && fromCard !== 'inherit_payer') {
    return fromCard;
  }

  return coverage?.fallbackPolicy || payer?.pricingPolicy?.missingItem || 'cash_fallback';
}

// ============================================
// Cash Fallback Quote
// ============================================

function cashFallbackQuote({ input, standardUnit, quantity, coverage, rateCard, reason }) {
  const total = round(standardUnit * quantity, rateCard?.rules?.rounding);

  return {
    resultType: 'cash_fallback',
    fallbackReason: reason || 'No matching payer tariff item; hospital cash price applied',
    serviceCode: input.externalCode || input.serviceCode || input.internalCode || null,
    rateCard: rateCard ? {
      id: rateCard._id,
      version: rateCard.version,
      name: rateCard.name,
    } : null,
    inputs: {
      payer: coverage?.payerId?.code || coverage?.payerId?.name || String(coverage?.payerId || ''),
      coverageId: coverage?._id,
      serviceDate: new Date(input.serviceDate || Date.now()),
      quantity,
    },
    amounts: {
      hospitalStandard: total,
      contracted: total,
      eligible: total,
      sponsorLiability: 0,
      patientLiability: total,
      nonAdmissible: 0,
      hospitalAdjustment: 0,
      hospitalConcession: 0,
      packageAbsorbed: 0,
      coPay: 0,
      deductible: 0,
      fixedPatientShare: 0,
      uncovered: 0,
    },
    explanation: [
      'Service is not present in the payer rate card',
      'Hospital SELF/cash rate applied as fallback',
    ],
    ruleTrace: [{ rule: 'missing_item_cash_fallback' }],
  };
}

// ============================================
// Non-Admissible Quote
// ============================================

function nonAdmissibleQuote({ input, standardUnit, quantity, coverage, rateCard, reason }) {
  const total = round(standardUnit * quantity, rateCard?.rules?.rounding);

  return {
    resultType: 'non_admissible',
    fallbackReason: reason || 'Service is not admissible under this payer contract',
    serviceCode: input.externalCode || input.serviceCode || input.internalCode || null,
    rateCard: rateCard ? {
      id: rateCard._id,
      version: rateCard.version,
      name: rateCard.name,
    } : null,
    inputs: {
      payer: coverage?.payerId?.code || String(coverage?.payerId || ''),
      coverageId: coverage?._id,
      serviceDate: new Date(input.serviceDate || Date.now()),
      quantity,
    },
    amounts: {
      hospitalStandard: total,
      contracted: total,
      eligible: 0,
      sponsorLiability: 0,
      patientLiability: total,
      nonAdmissible: total,
      hospitalAdjustment: 0,
      hospitalConcession: 0,
      packageAbsorbed: 0,
      coPay: 0,
      deductible: 0,
      fixedPatientShare: 0,
      uncovered: 0,
    },
    explanation: [
      'Payer contract marks the service as non-admissible',
      'Patient liability retained unless an authorised concession is applied',
    ],
    ruleTrace: [{ rule: 'non_admissible' }],
  };
}

// ============================================
// Coverage Limit Helpers
// ============================================

function remainingCoverageLimit(coverage) {
  const limit = Number(coverage?.beneficiary?.coverageLimit || 0);

  if (!limit) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, limit - Number(coverage?.beneficiary?.coverageLimitUsed || 0));
}

function remainingPreauth(coverage) {
  const approved = Number(coverage?.preAuthorisation?.approvedAmount || 0);

  if (!approved) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, approved - Number(coverage?.preAuthorisation?.consumedAmount || 0));
}

// ============================================
// Calculate Allocation
// ============================================

function calculateAllocation({ contracted, standardAmount, item, coverage, input, rounding }) {
  const patientRule = item.patientShare || {};

  let coPayPercentage = Number(
    input.coPayPercentage ?? coverage.beneficiary?.coPayPercentage ?? 0
  );

  let fixedPatientShare = 0;
  let sponsorCap = Number.POSITIVE_INFINITY;

  if (patientRule.mode === 'percentage') {
    coPayPercentage = Number(patientRule.percentage || 0);
  }

  if (patientRule.mode === 'fixed') {
    fixedPatientShare = Number(patientRule.fixedAmount || 0);
  }

  if (patientRule.mode === 'sponsor_cap') {
    sponsorCap = Number(patientRule.sponsorCap || 0);
  }

  if (patientRule.mode === 'patient_full') {
    sponsorCap = 0;
  }

  const contractCap = Number(input.sponsorApprovalCap || Number.POSITIVE_INFINITY);

  const eligible = round(
    Math.min(contracted, sponsorCap, contractCap, remainingCoverageLimit(coverage), remainingPreauth(coverage)),
    rounding
  );

  const uncovered = round(Math.max(0, contracted - eligible), rounding);
  const explicitNonAdmissible = round(Math.max(0, Number(input.nonAdmissibleAmount || 0)), rounding);

  const coPay = round(Math.min(eligible, eligible * Math.max(0, coPayPercentage) / 100), rounding);
  const patientFixed = round(Math.min(Math.max(0, eligible - coPay), Math.max(0, fixedPatientShare)), rounding);

  const deductibleRemaining = Math.max(
    0,
    Number(input.deductibleRemaining ?? Math.max(
      0,
      Number(coverage.beneficiary?.deductibleAmount || 0) -
      Number(coverage.beneficiary?.deductibleUsed || 0)
    ))
  );

  const deductible = round(
    Math.min(Math.max(0, eligible - coPay - patientFixed), deductibleRemaining),
    rounding
  );

  let patientLiability = round(coPay + deductible + patientFixed + explicitNonAdmissible, rounding);
  let hospitalConcession = 0;

  const balancePolicy = input.balanceBillingPolicy || coverage.balanceBillingPolicy || 'patient';

  if (uncovered > 0) {
    if (balancePolicy === 'patient') {
      patientLiability = round(patientLiability + uncovered, rounding);
    } else if (balancePolicy === 'hospital_concession' || balancePolicy === 'not_allowed') {
      hospitalConcession = uncovered;
    } else if (balancePolicy === 'requires_approval') {
      if (!input.balanceBillingApproved) {
        throw httpError(
          'Uncovered payer amount requires an authorised allocation decision',
          409,
          'BALANCE_BILLING_APPROVAL_REQUIRED',
          { uncovered }
        );
      }

      if (input.approvedUncoveredTreatment === 'patient') {
        patientLiability = round(patientLiability + uncovered, rounding);
      } else {
        hospitalConcession = uncovered;
      }
    }
  }

  const sponsorLiability = round(Math.max(0, eligible - coPay - deductible - patientFixed), rounding);
  const contractualAdjustment = round(standardAmount - contracted, rounding);

  return {
    eligible,
    sponsorLiability,
    patientLiability,
    nonAdmissible: explicitNonAdmissible,
    hospitalAdjustment: contractualAdjustment,
    hospitalConcession,
    coPay,
    deductible,
    fixedPatientShare: patientFixed,
    uncovered,
    balancePolicy,
  };
}

// ============================================
// Self Tariff Quote
// ============================================

async function selfTariffQuote(input, standardUnit, quantity, serviceDate) {
  const payer = await Payer.findOne({
    hospitalId: input.hospitalId,
    code: 'SELF',
    isActive: { $ne: false },
  }).lean();

  if (!payer) {
    return null;
  }

  const RateCard = require('../models/RateCard');

  const baseFilter = {
    hospitalId: input.hospitalId,
    payerId: payer._id,
    status: 'active',
    effectiveFrom: { $lte: serviceDate },
    $or: [
      { effectiveTo: { $exists: false } },
      { effectiveTo: null },
      { effectiveTo: { $gte: serviceDate } },
    ],
  };

  const rateCard = await RateCard.findOne({
    ...baseFilter,
    version: 'HOSPITAL-BASIC-2026-08-15',
  })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .lean()
    || await RateCard.findOne(baseFilter)
      .sort({ effectiveFrom: -1, createdAt: -1 })
      .lean();

  if (!rateCard) {
    return null;
  }

  const item = await findItem({
    hospitalId: input.hospitalId,
    rateCardId: rateCard._id,
    externalCode: input.externalCode || input.payerServiceCode,
    internalServiceModel: input.internalServiceModel,
    internalServiceId: input.internalServiceId,
    serviceType: input.serviceType || serviceTypeFromCharge(input.chargeType),
    doctorId: input.doctorId,
    encounterType: input.encounterType,
    visitType: input.visitType,
    wardEntitlement: input.wardEntitlement,
  });

  if (!item) {
    return null;
  }

  const cityTier = input.cityTier || 'I';
  const accreditation = input.accreditation || 'nabh_nabl';
  const wardEntitlement = input.wardEntitlement || 'general';

  const applied = applyConfiguredRateRules({
    item,
    rules: rateCard.rules || {},
    cityTier,
    accreditation,
    wardEntitlement,
    sameOtSessionIndex: input.sameOtSessionIndex || 1,
    bilateralSecond: input.bilateralSecond === true,
    withinPackagePeriod: input.withinPackagePeriod === true,
  });

  const unit = Number(applied.contractedUnit);

  if (!Number.isFinite(unit) || unit < 0) {
    return null;
  }

  const total = round(unit * quantity, rateCard.rules?.rounding);
  const standard = round(Number(standardUnit || unit) * quantity, rateCard.rules?.rounding);

  return {
    resultType: 'self',
    serviceCode: item.externalCode,
    rateCard: {
      id: rateCard._id,
      version: rateCard.version,
      name: rateCard.name,
    },
    rateCardItemId: item._id,
    inputs: {
      payer: 'SELF',
      serviceDate,
      quantity,
      cityTier,
      accreditation,
      wardEntitlement,
    },
    amounts: {
      hospitalStandard: standard,
      contracted: total,
      eligible: total,
      sponsorLiability: 0,
      patientLiability: total,
      nonAdmissible: 0,
      hospitalAdjustment: round(standard - total),
      hospitalConcession: 0,
      packageAbsorbed: 0,
      coPay: 0,
      deductible: 0,
      fixedPatientShare: 0,
      uncovered: 0,
    },
    explanation: [
      'Hospital SELF tariff master rate selected',
      ...(applied.explanation || []),
    ],
    ruleTrace: [
      { rule: 'hospital_self_tariff', rateCardItemId: item._id },
      ...(applied.ruleTrace || []),
    ],
  };
}

// ============================================
// Quote Pricing
// ============================================

async function quotePricing(input) {
  const serviceDate = new Date(input.serviceDate || Date.now());
  const quantity = Math.max(1, Number(input.quantity || 1));
  const standardUnit = await resolveStandardUnit(input);
  const standardAmount = standardUnit * quantity;

  const coverage = input.coverage || (input.admissionId
    ? await activeCoverage(input.hospitalId, input.admissionId)
    : input.appointmentId
      ? await activeAppointmentCoverage(input.hospitalId, input.appointmentId)
      : null);

  // Self coverage handling
  if (!coverage || coverage.payerCategory === 'self' || coverage.payerId?.type === 'self') {
    const tariffQuote = await selfTariffQuote(input, standardUnit, quantity, serviceDate);

    if (tariffQuote) {
      return tariffQuote;
    }

    return selfQuote(input, standardUnit, quantity, [
      'Standard hospital cash rate selected',
      coverage ? 'SELF coverage selected' : 'No sponsor coverage selected',
    ]);
  }

  // Verify eligibility
  if (!coverage.simulationOnly && coverage.eligibility?.status !== 'verified' && coverage.eligibility?.status !== 'emergency_override') {
    throw httpError('Coverage eligibility is not verified', 409, 'COVERAGE_NOT_VERIFIED');
  }

  const payer = coverage.payerId?.pricingPolicy
    ? coverage.payerId
    : await Payer.findOne({
        _id: coverage.payerId,
        hospitalId: input.hospitalId,
      });

  const rateCard = coverage.rateCardId
    ? coverage.rateCardId.rules
      ? coverage.rateCardId
      : await resolveEffectiveRateCard({
          hospitalId: input.hospitalId,
          payerId: payer?._id || coverage.payerId,
          serviceDate,
          explicitRateCardId: coverage.rateCardId?._id || coverage.rateCardId,
          allowDemo: coverage.simulationOnly,
        })
    : await resolveEffectiveRateCard({
        hospitalId: input.hospitalId,
        payerId: payer?._id || coverage.payerId,
        serviceDate,
        allowDemo: coverage.simulationOnly,
      });

  if (!rateCard) {
    const policy = coverage.fallbackPolicy || payer?.pricingPolicy?.missingItem || 'cash_fallback';

    if (policy === 'cash_fallback') {
      return cashFallbackQuote({
        input,
        standardUnit,
        quantity,
        coverage,
        rateCard: null,
        reason: 'No active payer rate card; hospital cash price applied',
      });
    }

    throw httpError('No effective rate card found for this coverage', 409, 'RATE_CARD_NOT_ACTIVE');
  }

  const serviceType = input.serviceType || serviceTypeFromCharge(input.chargeType);

  const packageDecision = input.skipPackageAdjudication
    ? null
    : await findActivePackageDecision({
        ...input,
        coverage,
        serviceType,
        serviceDate,
        standardAmount,
      });

  // Package included
  if (packageDecision?.decision === 'included') {
    const total = round(standardAmount, rateCard.rules?.rounding);

    return {
      resultType: 'package_included',
      serviceCode: input.externalCode || input.serviceCode || input.internalCode || null,
      rateCard: {
        id: rateCard._id,
        version: rateCard.version,
        name: rateCard.name,
      },
      packageCode: packageDecision.episode.packageCode,
      packageEpisodeId: packageDecision.episode._id,
      packageDecision: packageDecision.decision,
      packageAdjudication: packageDecision,
      inputs: {
        payer: payer?.code || payer?.name || String(coverage.payerId),
        coverageId: coverage._id,
        serviceDate,
        quantity,
      },
      amounts: {
        hospitalStandard: total,
        contracted: 0,
        eligible: 0,
        sponsorLiability: 0,
        patientLiability: 0,
        nonAdmissible: 0,
        hospitalAdjustment: 0,
        hospitalConcession: 0,
        packageAbsorbed: total,
        coPay: 0,
        deductible: 0,
        fixedPatientShare: 0,
        uncovered: 0,
      },
      explanation: [
        `Included in active package ${packageDecision.episode.packageCode}`,
        packageDecision.reason,
      ],
      ruleTrace: [
        { rule: 'package_inclusion', packageEpisodeId: packageDecision.episode._id },
      ],
    };
  }

  // Package cash fallback
  if (packageDecision?.decision === 'cash_fallback') {
    return cashFallbackQuote({
      input,
      standardUnit,
      quantity,
      coverage,
      rateCard,
      reason: `${packageDecision.reason}; hospital cash price applied`,
    });
  }

  // Find rate card item
  const item = await findItem({
    hospitalId: input.hospitalId,
    rateCardId: rateCard._id,
    externalCode: input.externalCode || input.payerServiceCode,
    internalServiceModel: input.internalServiceModel,
    internalServiceId: input.internalServiceId,
    serviceType: input.serviceType || serviceTypeFromCharge(input.chargeType),
    doctorId: input.doctorId,
    encounterType: input.encounterType,
    visitType: input.visitType,
    wardEntitlement: input.wardEntitlement,
  });

  if (!item) {
    const policy = missingItemPolicy(rateCard, coverage, payer);

    if (policy === 'cash_fallback') {
      return cashFallbackQuote({ input, standardUnit, quantity, coverage, rateCard });
    }

    if (policy === 'non_admissible') {
      return nonAdmissibleQuote({ input, standardUnit, quantity, coverage, rateCard });
    }

    throw httpError('Service is not mapped to the selected payer rate card', 422, 'PAYER_ITEM_NOT_FOUND');
  }

  // Non-admissible item
  if (item.pricingMode === 'non_admissible') {
    return nonAdmissibleQuote({
      input,
      standardUnit,
      quantity,
      coverage,
      rateCard,
      reason: `Payer item ${item.externalCode} is non-admissible`,
    });
  }

  // Ward entitlement check
  if (item.allowedWards?.length && !item.allowedWards.includes(
    input.wardEntitlement || coverage.beneficiary?.wardEntitlement || 'semi_private'
  )) {
    return nonAdmissibleQuote({
      input,
      standardUnit,
      quantity,
      coverage,
      rateCard,
      reason: 'Service is not allowed for the beneficiary ward entitlement',
    });
  }

  const cityTier = input.cityTier || coverage.rateContext?.cityTier || 'I';
  const accreditation = input.accreditation || coverage.rateContext?.accreditation || 'nabh_nabl';
  const wardEntitlement = input.wardEntitlement || coverage.beneficiary?.wardEntitlement || 'semi_private';
  const rules = rateCard.rules || {};

  const applied = applyConfiguredRateRules({
    item,
    rules,
    cityTier,
    accreditation,
    wardEntitlement,
    sameOtSessionIndex: input.sameOtSessionIndex || 1,
    bilateralSecond: input.bilateralSecond === true,
    withinPackagePeriod: input.withinPackagePeriod === true,
  });

  const contracted = round(applied.contractedUnit * quantity, rules.rounding);

  const allocation = calculateAllocation({
    contracted,
    standardAmount,
    item,
    coverage,
    input,
    rounding: rules.rounding,
  });

  return {
    resultType: ['excluded', 'limit_exceeded'].includes(packageDecision?.decision)
      ? `package_${packageDecision.decision}`
      : 'payer_rate',
    serviceCode: item.externalCode,
    rateCard: {
      id: rateCard._id,
      version: rateCard.version,
      name: rateCard.name,
    },
    rateCardItemId: item._id,
    packageCode: item.packageDefinition?.isPackage
      ? item.externalCode
      : packageDecision?.episode?.packageCode,
    packagePeriodDays: item.packagePeriodDays,
    packageEpisodeId: packageDecision?.episode?._id,
    packageDecision: packageDecision?.decision,
    packageAdjudication: packageDecision,
    inputs: {
      payer: payer?.code || payer?.name || String(coverage.payerId),
      coverageId: coverage._id,
      cityTier,
      accreditation,
      wardEntitlement,
      serviceDate,
      quantity,
      sameOtSessionIndex: input.sameOtSessionIndex || 1,
      bilateralSecond: Boolean(input.bilateralSecond),
      withinPackagePeriod: Boolean(input.withinPackagePeriod),
      coPayPercentage: Number(input.coPayPercentage ?? coverage.beneficiary?.coPayPercentage ?? 0),
      deductibleRemaining: Number(input.deductibleRemaining ?? coverage.beneficiary?.deductibleAmount ?? 0),
      balanceBillingPolicy: allocation.balancePolicy,
      simulationOnly: Boolean(coverage.simulationOnly),
    },
    amounts: {
      hospitalStandard: round(standardAmount, rules.rounding),
      contracted,
      eligible: allocation.eligible,
      sponsorLiability: allocation.sponsorLiability,
      patientLiability: allocation.patientLiability,
      nonAdmissible: allocation.nonAdmissible,
      hospitalAdjustment: allocation.hospitalAdjustment,
      hospitalConcession: allocation.hospitalConcession,
      packageAbsorbed: 0,
      coPay: allocation.coPay,
      deductible: allocation.deductible,
      fixedPatientShare: allocation.fixedPatientShare,
      uncovered: allocation.uncovered,
    },
    explanation: [
      ...applied.explanation,
      `${allocation.coPay} co-pay and ${allocation.deductible} deductible allocated`,
      allocation.uncovered > 0
        ? `${allocation.uncovered} uncovered amount handled by ${allocation.balancePolicy}`
        : 'No uncovered contracted amount',
      ...(['excluded', 'limit_exceeded'].includes(packageDecision?.decision)
        ? [`${packageDecision.decision === 'limit_exceeded' ? 'Package limit exceeded for' : 'Excluded from'} active package ${packageDecision.episode.packageCode}`]
        : []),
    ],
    ruleTrace: [
      ...applied.ruleTrace,
      {
        rule: 'liability_allocation',
        eligible: allocation.eligible,
        coPay: allocation.coPay,
        deductible: allocation.deductible,
        uncovered: allocation.uncovered,
        balancePolicy: allocation.balancePolicy,
      },
    ],
  };
}

// ============================================
// Pricing Snapshot
// ============================================

function pricingSnapshot(quote, input = {}) {
  return {
    rateCardId: quote.rateCard?.id,
    rateCardVersion: quote.rateCard?.version,
    rateCardItemId: quote.rateCardItemId,
    serviceCode: quote.serviceCode,
    internalServiceModel: input.internalServiceModel,
    internalServiceId: input.internalServiceId,
    resultType: quote.resultType,
    fallbackReason: quote.fallbackReason,
    packageCode: quote.packageCode,
    packageEpisodeId: quote.packageEpisodeId,
    packageTriggerRateCardItemId: quote.packageTriggerRateCardItemId,
    packageDecision: quote.packageDecision,
    inputs: quote.inputs,
    amounts: quote.amounts,
    explanation: quote.explanation,
    ruleTrace: quote.ruleTrace,
    pricedAt: new Date(),
  };
}

module.exports = {
  quotePricing,
  serviceTypeFromCharge,
  round,
  pricingSnapshot,
  findItem,
  resolveStandardUnit,
  calculateAllocation,
  selfTariffQuote,
};