'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Patient = require('../models/Patient');
const Hospital = require('../models/Hospital');
const HospitalSequence = require('../models/HospitalSequence');
const PatientVerification = require('../models/PatientVerification');
const { getOrCreateNabhSetting } = require('./nabhSetting.service');
const { sendSensitiveSms } = require('./nabhNotification.service');

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

function validateConfiguredRegistration(payload, settings) {
  const config = settings.patientRegistration || {};
  const errors = [];
  const channel = payload.registrationSource?.channel || payload.registrationChannel || 'internal';
  if (!(config.enabledChannels || ['internal']).includes(channel)) {
    errors.push(`Registration channel "${channel}" is disabled`);
  }
  for (const field of config.requiredFields || []) {
    const value = valueAt(payload, field);
    if (value === undefined || value === null || String(value).trim() === '') {
      errors.push(`${field} is required`);
    }
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
  normalizePhone,
  validateConfiguredRegistration,
  findDuplicateCandidates,
  nextPatientIdentifier,
  requestMobileOtp,
  verifyMobileOtp,
  consumeMobileVerification,
  registrationConfig
};
