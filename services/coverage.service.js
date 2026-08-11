const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAdmission = require('../models/IPDAdmission');
const Appointment = require('../models/Appointment');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const { appendDomainEvent } = require('./auditEvent.service');
const { rememberCoveragePreference } = require('./patientCoveragePreference.service');

function httpError(message, statusCode = 400, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function legacyEncounterSponsorType(payerType) {
  const raw = String(payerType || 'self').trim().toLowerCase();
  if (raw === 'self') return 'self';
  if (['private_insurer', 'tpa', 'tpa_managed'].includes(raw)) return 'insurance';
  if (raw === 'corporate') return 'company_panel';
  if (raw === 'pmjay') return 'ayushman_bharat';
  if (['cghs', 'state_scheme', 'echs', 'esic', 'government_other'].includes(raw)) return 'government_scheme';
  return 'other';
}

function sessionQuery(query, session) {
  return session ? query.session(session) : query;
}

async function tenantAdmission(hospitalId, admissionId, session) {
  const admission = await sessionQuery(IPDAdmission.findOne({ _id: admissionId, hospitalId }), session);
  if (!admission) throw httpError('Admission not found', 404);
  return admission;
}

async function tenantAppointment(hospitalId, appointmentId, session) {
  const appointment = await sessionQuery(Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId }), session);
  if (!appointment) throw httpError('Appointment not found', 404);
  return appointment;
}

function encounterFilter({ hospitalId, encounterType, encounterId, active = true }) {
  const filter = { hospitalId, encounterType, active };
  if (encounterType === 'OPD') filter.appointmentId = encounterId;
  else filter.admissionId = encounterId;
  return filter;
}

async function activeEncounterCoverage({ hospitalId, encounterType, encounterId, session }) {
  return sessionQuery(
    AdmissionCoverage.findOne(encounterFilter({ hospitalId, encounterType, encounterId }))
      .populate('payerId', 'code name type empanelment isActive pricingPolicy demoOnly networkStatus')
      .populate('tpaId', 'code name type')
      .populate('rateCardId', 'name version effectiveFrom effectiveTo status rules demoOnly'),
    session
  );
}

// Backward-compatible IPD helper.
async function activeCoverage(hospitalId, admissionId, session) {
  return activeEncounterCoverage({ hospitalId, encounterType: 'IPD', encounterId: admissionId, session });
}

async function activeAppointmentCoverage(hospitalId, appointmentId, session) {
  return activeEncounterCoverage({ hospitalId, encounterType: 'OPD', encounterId: appointmentId, session });
}

async function resolveEffectiveRateCard({ hospitalId, payerId, serviceDate = new Date(), explicitRateCardId, session, allowDemo = false }) {
  const when = new Date(serviceDate);
  const filter = {
    hospitalId,
    payerId,
    status: 'active',
    effectiveFrom: { $lte: when },
    $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: when } }]
  };
  if (!allowDemo) filter.demoOnly = { $ne: true };
  if (explicitRateCardId) filter._id = explicitRateCardId;
  return sessionQuery(RateCard.findOne(filter).sort({ effectiveFrom: -1, createdAt: -1 }), session);
}

function payerCoverageDefaults(payer, payload) {
  const policy = payer.pricingPolicy || {};
  const beneficiary = { ...(payload.beneficiary || {}) };
  if (beneficiary.coPayPercentage === undefined) beneficiary.coPayPercentage = Number(policy.defaultCoPayPercentage || 0);
  if (beneficiary.deductibleAmount === undefined) beneficiary.deductibleAmount = Number(policy.defaultDeductibleAmount || 0);
  return {
    beneficiary,
    fallbackPolicy: payload.fallbackPolicy || policy.missingItem || 'cash_fallback',
    balanceBillingPolicy: payload.balanceBillingPolicy || policy.balanceBilling || 'patient'
  };
}

async function createEncounterCoverage({ req, hospitalId, encounterType, encounterId, payload, session, activateImmediately = true }) {
  const normalizedType = String(encounterType || '').toUpperCase();
  if (!['OPD', 'IPD'].includes(normalizedType)) throw httpError('encounterType must be OPD or IPD');

  const encounter = normalizedType === 'OPD'
    ? await tenantAppointment(hospitalId, encounterId, session)
    : await tenantAdmission(hospitalId, encounterId, session);
  const patientId = normalizedType === 'OPD' ? encounter.patient_id : encounter.patientId;

  const payer = await sessionQuery(Payer.findOne({ _id: payload.payerId, hospitalId, isActive: true }), session);
  if (!payer) throw httpError('Active payer not found', 404);

  const simulationOnly = Boolean(payload.simulationOnly || payload.allowUnempanelled);
  if (payer.type !== 'self' && payer.empanelment?.status !== 'active' && !simulationOnly) {
    throw httpError('Payer empanelment must be active before production coverage can be used', 409, 'PAYER_NOT_EMPANELLED');
  }

  const currentFilter = encounterFilter({ hospitalId, encounterType: normalizedType, encounterId });
  const existing = await sessionQuery(AdmissionCoverage.findOne(currentFilter), session);
  if (existing && activateImmediately) {
    existing.active = false;
    existing.effectiveTo = new Date();
    existing.revision += 1;
    existing.updatedBy = req.user?._id;
    await existing.save({ session });
  }

  const rateCard = payer.type === 'self' ? null : await resolveEffectiveRateCard({
    hospitalId,
    payerId: payer._id,
    serviceDate: payload.effectiveFrom || new Date(),
    explicitRateCardId: payload.rateCardId,
    session,
    allowDemo: simulationOnly
  });
  if (payer.type !== 'self' && !rateCard && payload.allowPendingRateCard !== true) {
    throw httpError('No active rate card is available for the selected payer and effective date', 409, 'RATE_CARD_NOT_ACTIVE');
  }

  const defaults = payerCoverageDefaults(payer, payload);
  const eligibility = payload.eligibility || {
    status: payer.type === 'self' ? 'verified' : (payer.pricingPolicy?.requireEligibility === false ? 'verified' : 'pending')
  };
  const preAuthorisation = payload.preAuthorisation || {
    required: Boolean(payer.pricingPolicy?.requirePreAuthorisation),
    status: payer.pricingPolicy?.requirePreAuthorisation ? 'not_started' : 'not_required'
  };

  const document = {
    hospitalId,
    encounterType: normalizedType,
    patientId,
    payerId: payer._id,
    payerCategory: payload.payerCategory || payer.type,
    tpaId: payload.tpaId || payer.tpaId,
    planName: payload.planName,
    simulationOnly,
    beneficiary: defaults.beneficiary,
    eligibility,
    preAuthorisation,
    rateContext: payload.rateContext || {},
    rateCardId: rateCard?._id,
    rateCardVersion: rateCard?.version,
    rateCardFrozenAt: rateCard ? new Date() : undefined,
    fallbackPolicy: defaults.fallbackPolicy,
    balanceBillingPolicy: defaults.balanceBillingPolicy,
    convertedFromCoverageId: payload.convertedFromCoverageId,
    conversionReason: payload.conversionReason,
    documentChecklist: payload.documentChecklist || payer.documentChecklist || [],
    active: Boolean(activateImmediately),
    effectiveFrom: payload.effectiveFrom || new Date(),
    createdBy: req.user?._id,
    updatedBy: req.user?._id
  };
  if (normalizedType === 'OPD') document.appointmentId = encounter._id;
  else document.admissionId = encounter._id;

  const [coverage] = await AdmissionCoverage.create([document], { session });

  if (activateImmediately) {
    encounter.coverageId = coverage._id;
    encounter.sponsorType = legacyEncounterSponsorType(payer.type);
    encounter.sponsorName = payer.name;
    if (normalizedType === 'IPD') {
      encounter.patientReceivable = Number(encounter.patientReceivable || 0);
      encounter.sponsorReceivable = Number(encounter.sponsorReceivable || 0);
    }
    await encounter.save({ session });
  }

  await rememberCoveragePreference({
    hospitalId,
    coverage,
    userId: req.user?._id,
    session
  });

  await appendDomainEvent({
    req,
    eventType: existing ? 'coverage.replaced' : 'coverage.created',
    entityType: 'AdmissionCoverage',
    entityId: coverage._id,
    hospitalId,
    patientId,
    encounterId: encounter._id,
    afterSummary: {
      encounterType: normalizedType,
      payerId: payer._id,
      payerCategory: coverage.payerCategory,
      eligibility: coverage.eligibility.status,
      rateCardVersion: coverage.rateCardVersion,
      simulationOnly,
      active: coverage.active
    },
    session
  });
  return coverage;
}

async function createCoverage({ req, hospitalId, admissionId, payload, session }) {
  return createEncounterCoverage({ req, hospitalId, encounterType: 'IPD', encounterId: admissionId, payload, session });
}

async function findCoverageForUpdate({ hospitalId, encounterType = 'IPD', encounterId, coverageId, session }) {
  const filter = coverageId
    ? { _id: coverageId, hospitalId, active: true }
    : encounterFilter({ hospitalId, encounterType, encounterId });
  const coverage = await sessionQuery(AdmissionCoverage.findOne(filter), session);
  if (!coverage) throw httpError('Active coverage not found', 404);
  return coverage;
}

async function updateEligibility({ req, hospitalId, admissionId, appointmentId, coverageId, payload, session }) {
  const encounterType = appointmentId ? 'OPD' : 'IPD';
  const coverage = await findCoverageForUpdate({ hospitalId, encounterType, encounterId: appointmentId || admissionId, coverageId, session });
  const previous = coverage.eligibility?.status;
  coverage.eligibility = {
    ...coverage.eligibility?.toObject?.() || coverage.eligibility || {},
    ...payload,
    verifiedAt: ['verified', 'rejected', 'emergency_override'].includes(payload.status) ? new Date() : coverage.eligibility?.verifiedAt,
    verifiedBy: req.user?._id
  };
  coverage.updatedBy = req.user?._id;
  coverage.revision += 1;
  await coverage.save({ session });
  await appendDomainEvent({
    req,
    eventType: payload.status === 'verified' ? 'coverage.eligibility_verified' : payload.status === 'emergency_override' ? 'coverage.emergency_override' : 'coverage.eligibility_updated',
    entityType: 'AdmissionCoverage',
    entityId: coverage._id,
    hospitalId,
    patientId: coverage.patientId,
    encounterId: coverage.appointmentId || coverage.admissionId,
    revision: coverage.revision,
    beforeSummary: { status: previous },
    afterSummary: { status: coverage.eligibility.status, reason: coverage.eligibility.reason },
    session
  });
  return coverage;
}

async function updatePreAuth({ req, hospitalId, admissionId, appointmentId, coverageId, payload, session }) {
  const encounterType = appointmentId ? 'OPD' : 'IPD';
  const coverage = await findCoverageForUpdate({ hospitalId, encounterType, encounterId: appointmentId || admissionId, coverageId, session });
  const previous = coverage.preAuthorisation?.status;
  const history = Array.isArray(coverage.preAuthorisation?.history) ? coverage.preAuthorisation.history : [];
  coverage.preAuthorisation = {
    ...coverage.preAuthorisation?.toObject?.() || coverage.preAuthorisation || {},
    ...payload,
    submittedAt: payload.status === 'submitted' ? new Date() : coverage.preAuthorisation?.submittedAt,
    decisionAt: ['approved', 'partially_approved', 'rejected'].includes(payload.status) ? new Date() : coverage.preAuthorisation?.decisionAt,
    history: [...history, { status: payload.status || previous, at: new Date(), by: req.user?._id, note: payload.note || payload.decisionReason }]
  };
  coverage.updatedBy = req.user?._id;
  coverage.revision += 1;
  await coverage.save({ session });
  await appendDomainEvent({
    req,
    eventType: payload.status === 'approved' ? 'coverage.preauth_approved' : 'coverage.preauth_updated',
    entityType: 'AdmissionCoverage',
    entityId: coverage._id,
    hospitalId,
    patientId: coverage.patientId,
    encounterId: coverage.appointmentId || coverage.admissionId,
    revision: coverage.revision,
    beforeSummary: { status: previous },
    afterSummary: { status: coverage.preAuthorisation.status, approvedAmount: coverage.preAuthorisation.approvedAmount },
    session
  });
  return coverage;
}


async function activatePreparedCoverage({ req, hospitalId, coverageId, session }) {
  const coverage = await sessionQuery(AdmissionCoverage.findOne({ _id: coverageId, hospitalId }), session);
  if (!coverage) throw httpError('Coverage not found', 404);
  if (coverage.active) return coverage;
  const encounterId = coverage.encounterType === 'OPD' ? coverage.appointmentId : coverage.admissionId;
  const existing = await sessionQuery(AdmissionCoverage.findOne(encounterFilter({ hospitalId, encounterType: coverage.encounterType, encounterId })), session);
  if (existing && String(existing._id) !== String(coverage._id)) {
    existing.active = false;
    existing.effectiveTo = new Date();
    existing.revision += 1;
    existing.updatedBy = req.user?._id;
    await existing.save({ session });
    coverage.convertedFromCoverageId = coverage.convertedFromCoverageId || existing._id;
  }
  coverage.active = true;
  coverage.effectiveFrom = coverage.effectiveFrom || new Date();
  coverage.effectiveTo = undefined;
  coverage.updatedBy = req.user?._id;
  coverage.revision += 1;
  await coverage.save({ session });
  const encounter = coverage.encounterType === 'OPD'
    ? await tenantAppointment(hospitalId, coverage.appointmentId, session)
    : await tenantAdmission(hospitalId, coverage.admissionId, session);
  const payer = await sessionQuery(Payer.findById(coverage.payerId), session);
  encounter.coverageId = coverage._id;
  encounter.sponsorType = payer?.type || coverage.payerCategory;
  encounter.sponsorName = payer?.name;
  await encounter.save({ session });
  await rememberCoveragePreference({ hospitalId, coverage, userId: req.user?._id, session });
  await appendDomainEvent({
    req,
    eventType: 'coverage.activated',
    entityType: 'AdmissionCoverage',
    entityId: coverage._id,
    hospitalId,
    patientId: coverage.patientId,
    encounterId,
    afterSummary: { encounterType: coverage.encounterType, payerId: coverage.payerId, rateCardVersion: coverage.rateCardVersion },
    session
  });
  return coverage;
}

module.exports = {
  activeCoverage,
  activeAppointmentCoverage,
  activeEncounterCoverage,
  createCoverage,
  createEncounterCoverage,
  activatePreparedCoverage,
  updateEligibility,
  updatePreAuth,
  resolveEffectiveRateCard,
  tenantAdmission,
  tenantAppointment,
  encounterFilter,
  httpError
};
