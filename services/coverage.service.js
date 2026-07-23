const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAdmission = require('../models/IPDAdmission');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const { appendDomainEvent } = require('./auditEvent.service');

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function tenantAdmission(hospitalId, admissionId, session) {
  const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).session(session || null);
  if (!admission) throw httpError('Admission not found', 404);
  return admission;
}

async function activeCoverage(hospitalId, admissionId, session) {
  return AdmissionCoverage.findOne({ hospitalId, admissionId, active: true })
    .populate('payerId', 'code name type empanelment isActive')
    .populate('rateCardId', 'name version effectiveFrom effectiveTo status rules')
    .session(session || null);
}

async function resolveEffectiveRateCard({ hospitalId, payerId, serviceDate = new Date(), explicitRateCardId, session }) {
  const when = new Date(serviceDate);
  const filter = {
    hospitalId,
    payerId,
    status: 'active',
    effectiveFrom: { $lte: when },
    $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: when } }]
  };
  if (explicitRateCardId) filter._id = explicitRateCardId;
  return RateCard.findOne(filter).sort({ effectiveFrom: -1, createdAt: -1 }).session(session || null);
}

async function createCoverage({ req, hospitalId, admissionId, payload, session }) {
  const admission = await tenantAdmission(hospitalId, admissionId, session);
  const payer = await Payer.findOne({ _id: payload.payerId, hospitalId, isActive: true }).session(session || null);
  if (!payer) throw httpError('Approved payer not found', 404);

  const existing = await AdmissionCoverage.findOne({ hospitalId, admissionId, active: true }).session(session || null);
  if (existing) {
    existing.active = false;
    existing.effectiveTo = new Date();
    existing.revision += 1;
    existing.updatedBy = req.user?._id;
    await existing.save({ session });
  }

  const rateCard = await resolveEffectiveRateCard({
    hospitalId,
    payerId: payer._id,
    serviceDate: payload.effectiveFrom || new Date(),
    explicitRateCardId: payload.rateCardId,
    session
  });

  if (payer.type !== 'self' && !rateCard && payload.allowPendingRateCard !== true) {
    throw httpError('No active rate card is available for the selected payer and effective date', 409);
  }

  const [coverage] = await AdmissionCoverage.create([{
    hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    payerId: payer._id,
    payerCategory: payload.payerCategory || payer.type,
    tpaId: payload.tpaId,
    beneficiary: payload.beneficiary || {},
    eligibility: payload.eligibility || { status: payer.type === 'self' ? 'verified' : 'pending' },
    preAuthorisation: payload.preAuthorisation || { required: false, status: 'not_required' },
    rateContext: payload.rateContext || {},
    rateCardId: rateCard?._id,
    rateCardVersion: rateCard?.version,
    documentChecklist: payload.documentChecklist || payer.documentChecklist || [],
    effectiveFrom: payload.effectiveFrom || new Date(),
    createdBy: req.user?._id,
    updatedBy: req.user?._id
  }], { session });

  admission.coverageId = coverage._id;
  admission.sponsorType = payer.type === 'self' ? 'self' : payer.type;
  admission.sponsorName = payer.name;
  admission.patientReceivable = Number(admission.patientReceivable || 0);
  admission.sponsorReceivable = Number(admission.sponsorReceivable || 0);
  await admission.save({ session });

  await appendDomainEvent({
    req,
    eventType: 'coverage.created',
    entityType: 'AdmissionCoverage',
    entityId: coverage._id,
    hospitalId,
    patientId: admission.patientId,
    encounterId: admission._id,
    afterSummary: { payerId: payer._id, payerCategory: coverage.payerCategory, eligibility: coverage.eligibility.status, rateCardVersion: coverage.rateCardVersion },
    session
  });
  return coverage;
}

async function updateEligibility({ req, hospitalId, admissionId, payload, session }) {
  const coverage = await AdmissionCoverage.findOne({ hospitalId, admissionId, active: true }).session(session || null);
  if (!coverage) throw httpError('Active coverage not found', 404);
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
    entityType: 'AdmissionCoverage', entityId: coverage._id, hospitalId, patientId: coverage.patientId, encounterId: coverage.admissionId,
    revision: coverage.revision, beforeSummary: { status: previous }, afterSummary: { status: coverage.eligibility.status, reason: coverage.eligibility.reason }, session
  });
  return coverage;
}

async function updatePreAuth({ req, hospitalId, admissionId, payload, session }) {
  const coverage = await AdmissionCoverage.findOne({ hospitalId, admissionId, active: true }).session(session || null);
  if (!coverage) throw httpError('Active coverage not found', 404);
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
    entityType: 'AdmissionCoverage', entityId: coverage._id, hospitalId, patientId: coverage.patientId, encounterId: coverage.admissionId,
    revision: coverage.revision, beforeSummary: { status: previous }, afterSummary: { status: coverage.preAuthorisation.status, approvedAmount: coverage.preAuthorisation.approvedAmount }, session
  });
  return coverage;
}

module.exports = {
  activeCoverage,
  createCoverage,
  updateEligibility,
  updatePreAuth,
  resolveEffectiveRateCard,
  tenantAdmission
};
