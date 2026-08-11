'use strict';

const Patient = require('../models/Patient');
const Payer = require('../models/Payer');
const AdmissionCoverage = require('../models/AdmissionCoverage');

function legacySponsorType(payerType) {
  const raw = String(payerType || 'self').trim().toLowerCase();
  if (raw === 'self') return 'self';
  if (['private_insurer', 'tpa', 'tpa_managed'].includes(raw)) return 'insurance';
  if (raw === 'corporate') return 'company_panel';
  if (raw === 'pmjay') return 'ayushman_bharat';
  if (['cghs', 'state_scheme', 'echs', 'esic', 'government_other'].includes(raw)) return 'government_scheme';
  return 'other';
}

function beneficiarySnapshot(input = {}) {
  const source = input?.toObject?.() || input || {};
  return {
    beneficiaryId: source.beneficiaryId || undefined,
    schemeCardNumber: source.schemeCardNumber || undefined,
    policyNumber: source.policyNumber || undefined,
    memberId: source.memberId || undefined,
    relationship: source.relationship || undefined,
    validFrom: source.validFrom || undefined,
    validTo: source.validTo || undefined,
    coverageLimit: source.coverageLimit ?? undefined,
    coPayPercentage: source.coPayPercentage ?? undefined,
    deductibleAmount: source.deductibleAmount ?? undefined,
    wardEntitlement: source.wardEntitlement || undefined
  };
}

function responseFromPreference(preference, payer, sourceFallback = 'REGISTRATION') {
  if (!preference) return null;
  const data = preference?.toObject?.() || preference;
  const payerDoc = payer?.toObject?.() || payer;
  const category = payerDoc?.type || data.payerCategory || 'self';
  const usedAt = data.usedAt || null;
  const validTo = data.beneficiary?.validTo || null;
  return {
    payerId: payerDoc?._id || data.payerId || null,
    payerCategory: category,
    sponsorType: legacySponsorType(category),
    payerName: payerDoc?.name || data.payerName || (category === 'self' ? 'Self / Cash' : ''),
    payerCode: payerDoc?.code || null,
    payerActive: payerDoc ? payerDoc.isActive !== false : category === 'self',
    empanelmentStatus: payerDoc?.empanelment?.status || (category === 'self' ? 'not_required' : null),
    tpaId: data.tpaId || payerDoc?.tpaId || null,
    planName: data.planName || '',
    beneficiary: beneficiarySnapshot(data.beneficiary),
    source: data.source || sourceFallback,
    encounterId: data.encounterId || null,
    coverageId: data.coverageId || null,
    usedAt,
    expired: Boolean(validTo && new Date(validTo).getTime() < Date.now())
  };
}

async function preferenceFromRegistration(patient, hospitalId) {
  const payerId = patient.insurance_provider_id;
  if (!payerId || String(patient.sponsor_type || 'self') === 'self') {
    return {
      payerId: null,
      payerCategory: 'self',
      sponsorType: 'self',
      payerName: 'Self / Cash',
      payerCode: null,
      payerActive: true,
      empanelmentStatus: 'not_required',
      tpaId: null,
      planName: '',
      beneficiary: {},
      source: 'REGISTRATION',
      encounterId: null,
      coverageId: null,
      usedAt: patient.createdAt || null,
      expired: false
    };
  }
  const payer = await Payer.findOne({ _id: payerId, hospitalId }).lean();
  const category = payer?.type || 'other';
  return {
    payerId,
    payerCategory: category,
    sponsorType: patient.sponsor_type || legacySponsorType(category),
    payerName: payer?.name || patient.sponsor_name || '',
    payerCode: payer?.code || null,
    payerActive: payer ? payer.isActive !== false : false,
    empanelmentStatus: payer?.empanelment?.status || null,
    tpaId: payer?.tpaId || null,
    planName: '',
    beneficiary: beneficiarySnapshot({
      policyNumber: patient.sponsor_policy_number,
      validTo: patient.sponsor_valid_until,
      coPayPercentage: patient.insurance_coverage_percentage
    }),
    source: 'REGISTRATION',
    encounterId: null,
    coverageId: null,
    usedAt: patient.createdAt || null,
    expired: Boolean(patient.sponsor_valid_until && new Date(patient.sponsor_valid_until).getTime() < Date.now())
  };
}

async function getPatientCoveragePreference({ hospitalId, patientId }) {
  const patient = await Patient.findOne({ _id: patientId, hospitalId })
    .select('sponsor_type insurance_provider_id sponsor_name sponsor_policy_number sponsor_valid_until insurance_coverage_percentage lastCoveragePreference createdAt')
    .lean();
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }

  const cached = patient.lastCoveragePreference;
  if (cached?.usedAt || cached?.payerId || cached?.payerCategory) {
    const payer = cached.payerId
      ? await Payer.findOne({ _id: cached.payerId, hospitalId }).lean()
      : null;
    return responseFromPreference(cached, payer, cached.source || 'REGISTRATION');
  }

  // Backfill-friendly fallback for hospitals upgrading with historical coverage.
  const latestCoverage = await AdmissionCoverage.findOne({ hospitalId, patientId })
    .sort({ effectiveFrom: -1, createdAt: -1 })
    .populate('payerId', 'code name type isActive empanelment tpaId')
    .lean();
  if (latestCoverage) {
    return responseFromPreference({
      payerId: latestCoverage.payerId?._id || latestCoverage.payerId,
      payerCategory: latestCoverage.payerCategory,
      payerName: latestCoverage.payerId?.name,
      tpaId: latestCoverage.tpaId,
      planName: latestCoverage.planName,
      beneficiary: latestCoverage.beneficiary,
      source: latestCoverage.encounterType,
      encounterId: latestCoverage.appointmentId || latestCoverage.admissionId || latestCoverage.labRequestId,
      coverageId: latestCoverage._id,
      usedAt: latestCoverage.effectiveFrom || latestCoverage.createdAt
    }, latestCoverage.payerId, latestCoverage.encounterType);
  }

  return preferenceFromRegistration(patient, hospitalId);
}


async function resolveDeclaredCoveragePreference({ hospitalId, coverage = {} }) {
  const input = coverage || {};
  const requestedCategory = String(input.payerCategory || '').trim().toLowerCase();
  const payerId = input.payerId || null;

  if (!payerId) {
    if (requestedCategory && requestedCategory !== 'self') {
      const error = new Error('Select an approved payer for sponsored coverage');
      error.statusCode = 400;
      error.code = 'PAYER_REQUIRED';
      throw error;
    }
    return {
      payer: null,
      payerId: null,
      payerCategory: 'self',
      payerName: 'Self / Cash',
      tpaId: null,
      planName: '',
      beneficiary: beneficiarySnapshot(input.beneficiary),
      preAuthorisation: input.preAuthorisation || {},
      source: 'EXPLICIT'
    };
  }

  const payer = await Payer.findOne({ _id: payerId, hospitalId, isActive: true }).lean();
  if (!payer) {
    const error = new Error('Selected payer is not active or does not belong to this hospital');
    error.statusCode = 400;
    error.code = 'INVALID_PAYER';
    throw error;
  }

  return {
    payer,
    payerId: payer._id,
    payerCategory: payer.type || requestedCategory || 'other',
    payerName: payer.name,
    tpaId: input.tpaId || payer.tpaId || null,
    planName: input.planName || '',
    beneficiary: beneficiarySnapshot(input.beneficiary),
    preAuthorisation: input.preAuthorisation || {},
    source: 'EXPLICIT'
  };
}

async function rememberDeclaredPreference({
  hospitalId,
  patientId,
  payer,
  payerId,
  payerCategory,
  payerName,
  tpaId,
  planName,
  beneficiary,
  source = 'OTHER',
  encounterId,
  coverageId,
  userId,
  usedAt = new Date(),
  updateLegacyPatientFields = false,
  session
}) {
  let payerDoc = payer?.toObject?.() || payer || null;
  const resolvedPayerId = payerDoc?._id || payerId || null;
  if (!payerDoc && resolvedPayerId) {
    const query = Payer.findOne({ _id: resolvedPayerId, hospitalId });
    if (session) query.session(session);
    payerDoc = await query.lean();
  }

  const category = payerDoc?.type || payerCategory || 'self';
  const snapshot = beneficiarySnapshot(beneficiary);
  const preferenceUsedAt = new Date(usedAt || Date.now());
  const safeUsedAt = Number.isNaN(preferenceUsedAt.getTime()) ? new Date() : preferenceUsedAt;
  const set = {
    lastCoveragePreference: {
      payerId: resolvedPayerId || undefined,
      payerCategory: category,
      payerName: payerDoc?.name || payerName || (category === 'self' ? 'Self / Cash' : undefined),
      tpaId: tpaId || payerDoc?.tpaId || undefined,
      planName: planName || undefined,
      beneficiary: snapshot,
      source,
      encounterId: encounterId || undefined,
      coverageId: coverageId || undefined,
      usedAt: safeUsedAt,
      updatedBy: userId || undefined
    }
  };

  if (updateLegacyPatientFields) {
    set.sponsor_type = legacySponsorType(category);
    set.insurance_provider_id = category === 'self' ? undefined : resolvedPayerId || undefined;
    set.sponsor_name = category === 'self' ? undefined : (payerDoc?.name || payerName || undefined);
    set.sponsor_policy_number = category === 'self'
      ? undefined
      : (snapshot.policyNumber || snapshot.memberId || snapshot.beneficiaryId || snapshot.schemeCardNumber || undefined);
    set.sponsor_valid_until = category === 'self' ? undefined : snapshot.validTo || undefined;
  }

  const options = { new: true };
  if (session) options.session = session;
  // Offline and retry sync can arrive out of order. Only let an event replace
  // the suggestion when it is at least as recent as the current preference.
  // This prevents an older offline appointment from becoming the patient's
  // "last used" payer merely because it synchronized later.
  return Patient.findOneAndUpdate({
    _id: patientId,
    hospitalId,
    $or: [
      { 'lastCoveragePreference.usedAt': { $exists: false } },
      { 'lastCoveragePreference.usedAt': null },
      { 'lastCoveragePreference.usedAt': { $lte: safeUsedAt } }
    ]
  }, { $set: set }, options);
}

async function rememberCoveragePreference({ hospitalId, coverage, userId, session }) {
  if (!coverage?.patientId) return null;
  let payer = coverage.payerId;
  if (!payer?.type && payer) {
    const query = Payer.findOne({ _id: payer, hospitalId });
    if (session) query.session(session);
    payer = await query.lean();
  }
  return rememberDeclaredPreference({
    hospitalId,
    patientId: coverage.patientId,
    payer,
    payerId: coverage.payerId?._id || coverage.payerId,
    payerCategory: coverage.payerCategory,
    payerName: payer?.name,
    tpaId: coverage.tpaId,
    planName: coverage.planName,
    beneficiary: coverage.beneficiary,
    source: coverage.encounterType || 'OTHER',
    encounterId: coverage.appointmentId || coverage.admissionId || coverage.labRequestId,
    coverageId: coverage._id,
    userId,
    usedAt: coverage.effectiveFrom || new Date(),
    updateLegacyPatientFields: false,
    session
  });
}

module.exports = {
  legacySponsorType,
  getPatientCoveragePreference,
  resolveDeclaredCoveragePreference,
  rememberDeclaredPreference,
  rememberCoveragePreference
};
