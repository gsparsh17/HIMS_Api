'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Patient = require('../models/Patient');
const Hospital = require('../models/Hospital');
const HospitalSequence = require('../models/HospitalSequence');
const PatientVerification = require('../models/PatientVerification');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const Payer = require('../models/Payer');
const { getOrCreateNabhSetting } = require('./nabhSetting.service');
const { sendSensitiveSms } = require('./nabhNotification.service');
const { rememberDeclaredPreference } = require('./patientCoveragePreference.service');

const REGISTRATION_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  DUPLICATE_REVIEW: 'DUPLICATE_REVIEW',
  REGISTERED: 'REGISTERED',
  MERGED: 'MERGED',
  INACTIVE: 'INACTIVE'
});

const CONTEXT_BASE_FIELDS = Object.freeze({
  OPD: ['first_name', 'phone', 'gender', 'dob'],
  IPD: ['first_name', 'phone', 'gender', 'dob'],
  WALKIN_LAB: ['first_name', 'phone', 'gender', 'dob'],
  EMERGENCY: ['first_name', 'gender']
});

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function dateOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function valueAt(payload, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], payload);
}

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

function registrationError(message, statusCode = 400, code = 'REGISTRATION_ERROR', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...details });
}


async function resolveRegistrationPayer(hospitalId, payload) {
  const sponsorType = String(payload.sponsor_type || 'self').trim().toLowerCase();
  if (sponsorType === 'self') {
    payload.sponsor_type = 'self';
    payload.insurance_provider_id = undefined;
    payload.sponsor_name = undefined;
    payload.sponsor_policy_number = undefined;
    payload.sponsor_valid_until = undefined;
    return null;
  }

  if (!payload.insurance_provider_id) {
    throw registrationError(
      'An approved payer must be selected for sponsored/insured registration',
      400,
      'PAYER_REQUIRED'
    );
  }

  const payer = await Payer.findOne({
    _id: payload.insurance_provider_id,
    hospitalId,
    isActive: true
  }).lean();

  if (!payer) {
    throw registrationError(
      'Selected payer is not active or does not belong to this hospital',
      400,
      'INVALID_PAYER'
    );
  }

  // Never trust a free-text payer name from a registration client. The payer
  // master is the hospital-scoped source of truth.
  payload.insurance_provider_id = payer._id;
  payload.sponsor_name = payer.name;
  return payer;
}

function validateConfiguredRegistration(payload, settings) {
  const config = settings.patientRegistration || {};
  const errors = [];
  const channel = payload.registrationSource?.channel || payload.registrationChannel || 'internal';
  if (!(config.enabledChannels || ['internal']).includes(channel)) {
    errors.push(`Registration channel "${channel}" is disabled`);
  }
  for (const field of config.requiredFields || []) {
    const value = valueAt(payload, field);
    if (!hasValue(value)) errors.push(`${field} is required`);
  }
  const configuredPaymentPreferences = (config.paymentPreferences || [])
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);
  if (payload.paymentPreference && configuredPaymentPreferences.length
    && !configuredPaymentPreferences.includes(String(payload.paymentPreference).trim().toLowerCase())) {
    errors.push(`Payment preference "${payload.paymentPreference}" is not enabled`);
  }
  if (config.requireMobileOtp
    && !payload.mobileVerification?.verified
    && !payload.capturedOffline
    && !payload.offlineSyncMetadata?.capturedOffline) {
    errors.push('Verified mobile number is required');
  }
  return errors;
}


function sanitizeRegistrationAbha(abha) {
  if (!abha || (!hasValue(abha.number) && !hasValue(abha.address))) return undefined;
  return {
    number: hasValue(abha.number) ? String(abha.number).trim() : undefined,
    address: hasValue(abha.address) ? String(abha.address).trim().toLowerCase() : undefined,
    status: 'manually_captured',
    registrationMode: 'manual_capture',
    kycVerified: false,
    verificationMethod: undefined,
    verifiedAt: undefined,
    linkedAt: undefined
  };
}

function scoreDuplicate(patient, payload) {
  const matches = [];
  let score = 0;
  const phone = normalizePhone(payload.phone);
  const patientPhone = normalizePhone(patient.phone);
  if (phone && phone === patientPhone) { score += 55; matches.push('phone'); }
  if (payload.abha?.number && normalizeText(payload.abha.number) === normalizeText(patient.abha?.number)) {
    score += 100; matches.push('abha.number');
  }
  if (payload.aadhaar_last4 && String(payload.aadhaar_last4) === String(patient.aadhaar_last4 || '')) {
    score += 70; matches.push('aadhaar_last4');
  }
  const nameMatch = normalizeText(payload.first_name) === normalizeText(patient.first_name)
    && normalizeText(payload.last_name) === normalizeText(patient.last_name);
  if (nameMatch) { score += 20; matches.push('name'); }
  if (dateOnly(payload.dob) && dateOnly(payload.dob) === dateOnly(patient.dob)) {
    score += 20; matches.push('dob');
  }
  if (normalizeText(payload.address) && normalizeText(payload.address) === normalizeText(patient.address)) {
    score += 5; matches.push('address');
  }
  return {
    patientId: patient._id,
    uhid: patient.uhid || patient.patientId,
    name: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
    phone: patient.phone,
    dob: patient.dob,
    score,
    matches,
    classification: score >= 100 ? 'exact' : score >= 55 ? 'probable' : 'weak'
  };
}

async function findDuplicateCandidates(hospitalId, payload, { limit = 20 } = {}) {
  const clauses = [];
  const phone = normalizePhone(payload.phone);
  if (phone) clauses.push({ $or: [{ normalizedPhone: phone }, { phone: new RegExp(`${phone}$`) }] });
  if (payload.abha?.number) clauses.push({ 'abha.number': payload.abha.number });
  if (payload.aadhaar_last4) clauses.push({ aadhaar_last4: payload.aadhaar_last4 });
  if (payload.first_name) clauses.push({ first_name: new RegExp(`^${normalizeText(payload.first_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') });
  if (!clauses.length) return [];
  const patients = await Patient.find({ hospitalId, $or: clauses })
    .select('+aadhaar_last4 first_name middle_name last_name phone normalizedPhone dob address uhid patientId abha')
    .limit(Math.max(1, Math.min(100, Number(limit || 20))))
    .lean();
  return patients
    .map((patient) => scoreDuplicate(patient, payload))
    .filter((candidate) => candidate.score >= 20)
    .sort((a, b) => b.score - a.score);
}

function registrationFieldsForContext(settings, context = 'OPD') {
  const normalizedContext = String(context || 'OPD').toUpperCase();
  const configured = settings?.patientRegistration?.requiredFields || [];
  return [...new Set([...(CONTEXT_BASE_FIELDS[normalizedContext] || CONTEXT_BASE_FIELDS.OPD), ...configured])];
}

function calculateRegistrationCompleteness(patientLike, settings, context = 'OPD') {
  const fields = registrationFieldsForContext(settings, context);
  const missingFields = fields.filter((field) => !hasValue(valueAt(patientLike, field)));
  const completed = Math.max(0, fields.length - missingFields.length);
  return {
    score: fields.length ? Math.round((completed / fields.length) * 100) : 100,
    missingFields,
    evaluatedAt: new Date(),
    context: String(context || 'OPD').toUpperCase()
  };
}

async function assertPatientReadyForContext({ hospitalId, patientId, context = 'OPD', userId, session = null }) {
  const query = Patient.findOne({ _id: patientId, hospitalId });
  if (session) query.session(session);
  const patient = await query;
  if (!patient) throw registrationError('Patient not found in this hospital', 404, 'PATIENT_NOT_FOUND');

  if (['MERGED', 'INACTIVE'].includes(patient.registrationStatus)) {
    throw registrationError(
      `Patient registration is ${String(patient.registrationStatus).toLowerCase()}`,
      409,
      'PATIENT_REGISTRATION_INACTIVE'
    );
  }
  if (patient.registrationStatus === REGISTRATION_STATES.DUPLICATE_REVIEW
    || patient.duplicateReview?.status === 'probable_duplicate') {
    throw registrationError(
      'Patient registration requires duplicate review before this workflow can continue',
      409,
      'PATIENT_DUPLICATE_REVIEW_REQUIRED'
    );
  }

  const settings = await getOrCreateNabhSetting(hospitalId, userId);
  const completeness = calculateRegistrationCompleteness(patient, settings, context);
  if (completeness.missingFields.length) {
    throw registrationError(
      `Patient registration is incomplete for ${String(context).toUpperCase()}`,
      409,
      'PATIENT_REGISTRATION_INCOMPLETE',
      { missingFields: completeness.missingFields, completeness }
    );
  }

  return { patient, completeness, settings };
}

function buildRegistrationPayload(input, { hospitalId, userId, defaultPatientType = 'opd' }) {
  const capturedOffline = Boolean(input.capturedOffline || input.localId || input.tempPatientId);
  return {
    ...input,
    // Registration may capture a patient-reported ABHA identifier, but only
    // ABDM verification endpoints are allowed to promote it to VERIFIED.
    abha: sanitizeRegistrationAbha(input.abha),
    hospitalId,
    normalizedPhone: normalizePhone(input.phone),
    patient_type: input.patient_type || defaultPatientType,
    mobileVerification: { verified: false },
    registrationSource: {
      channel: input.registrationSource?.channel || input.registrationChannel || 'internal',
      externalReference: input.registrationSource?.externalReference,
      deviceIdentifier: input.registrationSource?.deviceIdentifier,
      capturedAt: input.registrationSource?.capturedAt || input.offlineCapturedAt || new Date(),
      capturedBy: userId
    },
    offlineSyncMetadata: {
      localId: input.localId || input.tempPatientId,
      capturedOffline,
      capturedAt: input.offlineCapturedAt || input.registrationSource?.capturedAt,
      syncedAt: capturedOffline ? new Date() : undefined,
      idempotencyKey: input.idempotencyKey
    }
  };
}

async function registerPatient({
  hospitalId,
  input,
  userId,
  reuseExactMatch = false,
  offlineReplay = false,
  defaultPatientType = 'opd'
}) {
  if (!hospitalId) throw registrationError('Hospital context is required', 400, 'HOSPITAL_CONTEXT_REQUIRED');
  const source = input || {};
  const settings = await getOrCreateNabhSetting(hospitalId, userId);

  if (source.idempotencyKey) {
    const existingReplay = await Patient.findOne({
      hospitalId,
      'offlineSyncMetadata.idempotencyKey': String(source.idempotencyKey)
    });
    if (existingReplay) {
      return {
        patient: existingReplay,
        created: false,
        idempotent: true,
        duplicateMatched: false,
        candidates: [],
        duplicateReview: existingReplay.duplicateReview
      };
    }
  }

  const payload = buildRegistrationPayload(source, { hospitalId, userId, defaultPatientType });

  const registrationPayer = await resolveRegistrationPayer(hospitalId, payload);

  if (source.mobileVerification?.verificationId) {
    const verified = await verifyMobileOtp({
      hospitalId,
      verificationId: source.mobileVerification.verificationId,
      phone: source.phone,
      otp: source.mobileVerification.otp
    });
    payload.mobileVerification = {
      verified: true,
      verifiedAt: verified.verifiedAt,
      verificationId: verified.verificationId,
      phone: verified.phone
    };
  }

  const validationErrors = validateConfiguredRegistration(payload, settings);
  if (validationErrors.length) {
    throw registrationError(
      validationErrors.join('; '),
      400,
      'REGISTRATION_VALIDATION_FAILED',
      { fields: validationErrors }
    );
  }

  const candidates = await findDuplicateCandidates(hospitalId, payload);
  const exact = candidates.find((candidate) => candidate.classification === 'exact');
  const probable = candidates.find((candidate) => candidate.classification === 'probable');
  const duplicateOverrideReason = String(
    source.duplicateOverride?.reason || (source.force_create ? 'Legacy force_create override' : '')
  ).trim();

  if (exact && !source.force_create) {
    if (reuseExactMatch || offlineReplay) {
      const existing = await Patient.findOne({ _id: exact.patientId, hospitalId });
      if (source.localId || source.tempPatientId) {
        await OfflineSyncLog.findOneAndUpdate(
          { hospitalId, localId: source.localId || source.tempPatientId, entityType: 'PATIENT' },
          {
            hospitalId,
            localId: source.localId || source.tempPatientId,
            entityType: 'PATIENT',
            operationType: 'CREATE',
            data: source,
            status: 'SYNCED',
            serverId: existing._id,
            syncedAt: new Date()
          },
          { upsert: true, new: true }
        );
      }
      return {
        patient: existing,
        created: false,
        duplicateMatched: true,
        candidates,
        duplicateReview: existing.duplicateReview
      };
    }
    throw registrationError(
      'An exact duplicate patient record was detected',
      409,
      'DUPLICATE_PATIENT',
      { candidates }
    );
  }

  if (probable && !duplicateOverrideReason) {
    throw registrationError(
      'A probable duplicate patient record was detected. Review or provide an override reason.',
      409,
      'PROBABLE_DUPLICATE_PATIENT',
      {
        candidates,
        overrideAllowed: Boolean(settings.patientRegistration?.allowProbableDuplicateOverride)
      }
    );
  }

  if (probable && !settings.patientRegistration?.allowProbableDuplicateOverride) {
    throw registrationError(
      'Probable duplicate override is disabled by hospital policy',
      409,
      'DUPLICATE_OVERRIDE_DISABLED',
      { candidates }
    );
  }

  payload.duplicateReview = {
    status: probable ? 'override_approved' : 'clear',
    candidatePatientIds: candidates.map((candidate) => candidate.patientId),
    score: candidates[0]?.score || 0,
    matchedFields: candidates[0]?.matches || [],
    reviewedAt: new Date(),
    reviewedBy: userId,
    overrideReason: duplicateOverrideReason
  };

  const completeness = calculateRegistrationCompleteness(payload, settings, 'OPD');
  payload.registrationCompleteness = completeness;
  payload.registrationStatus = payload.offlineSyncMetadata?.capturedOffline && settings.patientRegistration?.requireMobileOtp
    && !payload.mobileVerification?.verified
    ? REGISTRATION_STATES.PENDING_VERIFICATION
    : REGISTRATION_STATES.REGISTERED;

  if (payload.mobileVerification?.verified) {
    await consumeMobileVerification({
      hospitalId,
      verificationId: payload.mobileVerification.verificationId,
      phone: payload.phone
    });
  }

  const {
    localId, tempPatientId, isSynced, force_create, registrationChannel,
    duplicateOverride, capturedOffline, offlineCapturedAt, idempotencyKey,
    ...cleanPayload
  } = payload;
  const patient = await Patient.create(cleanPayload);

  await rememberDeclaredPreference({
    hospitalId,
    patientId: patient._id,
    payer: registrationPayer,
    payerId: registrationPayer?._id,
    payerCategory: registrationPayer?.type || 'self',
    payerName: registrationPayer?.name,
    beneficiary: {
      policyNumber: payload.sponsor_policy_number,
      validTo: payload.sponsor_valid_until,
      coPayPercentage: payload.insurance_coverage_percentage
    },
    source: 'REGISTRATION',
    userId,
    usedAt: patient.createdAt || new Date(),
    updateLegacyPatientFields: false
  });

  if (source.localId || source.tempPatientId) {
    await OfflineSyncLog.findOneAndUpdate(
      { hospitalId, localId: source.localId || source.tempPatientId, entityType: 'PATIENT' },
      {
        hospitalId,
        localId: source.localId || source.tempPatientId,
        entityType: 'PATIENT',
        operationType: 'CREATE',
        data: source,
        status: 'SYNCED',
        serverId: patient._id,
        syncedAt: new Date()
      },
      { upsert: true, new: true }
    );
  }

  return {
    patient,
    created: true,
    duplicateMatched: false,
    candidates,
    duplicateReview: payload.duplicateReview,
    completeness
  };
}

async function nextPatientIdentifier(hospitalId, template) {
  const hospital = await Hospital.findById(hospitalId).select('hospitalID tenantCode').lean();
  if (!hospital) throw new Error('Hospital not found');
  const now = new Date();
  const sequence = await HospitalSequence.findOneAndUpdate(
    { hospitalId, key: `PATIENT_${now.getFullYear()}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const replacements = {
    HOSPITAL: hospital.tenantCode || hospital.hospitalID,
    YYYY: String(now.getFullYear()),
    YY: String(now.getFullYear()).slice(-2),
    MM: String(now.getMonth() + 1).padStart(2, '0'),
    DD: String(now.getDate()).padStart(2, '0'),
    SEQUENCE: String(sequence.value).padStart(6, '0'),
    RANDOM: crypto.randomBytes(4).toString('hex').toUpperCase()
  };
  let identifier = String(template || '{HOSPITAL}-{YY}{MM}-{SEQUENCE}');
  for (const [key, value] of Object.entries(replacements)) {
    identifier = identifier.replaceAll(`{${key}}`, value);
  }
  return identifier.toUpperCase().replace(/\s+/g, '-');
}

async function requestMobileOtp({ hospitalId, phone, requestedBy }) {
  const normalized = normalizePhone(phone);
  if (normalized.length < 10) throw new Error('A valid mobile number is required');
  await PatientVerification.updateMany(
    { hospitalId, phone: normalized, status: 'pending' },
    { $set: { status: 'cancelled' } }
  );
  const otp = String(crypto.randomInt(100000, 1000000));
  const verification = await PatientVerification.create({
    hospitalId,
    phone: normalized,
    otpHash: await bcrypt.hash(otp, 8),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    requestedBy
  });
  const delivery = await sendSensitiveSms({
    hospitalId,
    eventType: 'patient_mobile_otp',
    correlationId: String(verification._id),
    phone: normalized,
    subject: 'Patient mobile verification',
    message: `Your mobile verification code is ${otp}. It expires in 5 minutes.`,
    createdBy: requestedBy
  });
  verification.notificationDeliveryId = delivery._id;
  await verification.save();
  return {
    verificationId: verification._id,
    phone: normalized,
    expiresAt: verification.expiresAt,
    deliveryStatus: delivery.status,
    ...(process.env.NODE_ENV !== 'production' && process.env.EXPOSE_TEST_OTP === 'true' ? { testOtp: otp } : {})
  };
}

async function verifyMobileOtp({ hospitalId, verificationId, phone, otp }) {
  const verification = await PatientVerification.findOne({
    _id: verificationId,
    hospitalId,
    phone: normalizePhone(phone)
  }).select('+otpHash');
  if (!verification) throw new Error('Verification request not found');
  if (verification.status === 'consumed') throw new Error('Verification code has already been used');
  if (verification.status === 'verified') {
    return {
      verificationId: verification._id,
      phone: verification.phone,
      verified: true,
      verifiedAt: verification.verifiedAt
    };
  }
  if (verification.status !== 'pending') throw new Error(`Verification is ${verification.status}`);
  if (verification.expiresAt <= new Date()) {
    verification.status = 'expired';
    await verification.save();
    throw new Error('Verification code expired');
  }
  verification.attempts += 1;
  const valid = await bcrypt.compare(String(otp || ''), verification.otpHash);
  if (!valid) {
    const exhausted = verification.attempts >= verification.maxAttempts;
    if (exhausted) verification.status = 'failed';
    await verification.save();
    throw new Error(exhausted
      ? 'Maximum verification attempts exceeded'
      : 'Invalid verification code');
  }
  verification.status = 'verified';
  verification.verifiedAt = new Date();
  await verification.save();
  return {
    verificationId: verification._id,
    phone: verification.phone,
    verified: true,
    verifiedAt: verification.verifiedAt
  };
}

async function consumeMobileVerification({ hospitalId, verificationId, phone }) {
  const verification = await PatientVerification.findOneAndUpdate(
    {
      _id: verificationId,
      hospitalId,
      phone: normalizePhone(phone),
      status: 'verified'
    },
    { $set: { status: 'consumed', consumedAt: new Date() } },
    { new: true }
  );
  if (!verification) {
    throw new Error('Mobile verification is invalid, expired, or already used');
  }
  return verification;
}

async function registrationConfig(hospitalId, userId) {
  const setting = await getOrCreateNabhSetting(hospitalId, userId);
  const config = setting.patientRegistration?.toObject?.()
    || setting.patientRegistration
    || {};
  return {
    ...config,
    supportedIdentityFields: ['aadhaar_last4', 'abha.number', 'abha.address'],
    supportedInsuranceFields: [
      'sponsor_type', 'insurance_provider_id', 'sponsor_name',
      'sponsor_policy_number', 'sponsor_valid_until', 'insurance_coverage_percentage'
    ]
  };
}

module.exports = {
  REGISTRATION_STATES,
  normalizePhone,
  validateConfiguredRegistration,
  findDuplicateCandidates,
  registrationFieldsForContext,
  calculateRegistrationCompleteness,
  assertPatientReadyForContext,
  registerPatient,
  nextPatientIdentifier,
  requestMobileOtp,
  verifyMobileOtp,
  consumeMobileVerification,
  registrationConfig
};
