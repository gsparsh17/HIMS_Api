const Patient = require('../models/Patient');
const AbdmIdentityTransaction = require('../models/AbdmIdentityTransaction');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const RadiologyRequest = require('../models/RadiologyRequest');
const DischargeSummary = require('../models/DischargeSummary');
const EHRBundle = require('../models/EHRBundle');
const { generateEhrBundle } = require('../services/ehr.service');
const { encryptForAbdm, abdmPost, abdmGet } = require('../services/abdm.service');
const {
  storePatientSession,
  getActiveAccessToken,
  getPatientSessionStatus
} = require('../services/abdmCredential.service');
const {
  consentEvidence,
  createTransaction,
  getOwnedTransaction,
  assertResendAllowed,
  recordAttempt,
  markCompleted
} = require('../services/abdmIdentityTransaction.service');
const abdmConfig = require('../config/abdm.config');
const { assertSameHospital, assertUserHospital } = require('../utils/hospitalScope');
const { abhaStatusFilter, patientSearchConditions } = require('../utils/searchNormalization');

function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidAadhaar(value) {
  return /^\d{12}$/.test(cleanDigits(value));
}

function isValidMobile(value) {
  return /^[6-9]\d{9}$/.test(cleanDigits(value));
}

function normalizedAbhaNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function displayAbhaNumber(value) {
  const digits = normalizedAbhaNumber(value);
  if (digits.length !== 14) return value;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

function getAbhaAddress(profile = {}) {
  if (Array.isArray(profile.phrAddress) && profile.phrAddress.length) {
    return profile.phrAddress[0];
  }
  if (Array.isArray(profile.abhaAddress) && profile.abhaAddress.length) {
    return profile.abhaAddress[0];
  }
  return (
    profile.preferredAbhaAddress ||
    profile.ABHAAddress ||
    profile.abhaAddress ||
    undefined
  );
}

function extractProfile(data = {}) {
  return data.ABHAProfile || data.abhaProfile || data.profile || data;
}

function extractTokens(data = {}) {
  return data.tokens || data.token || {};
}

async function ensurePatient(patientId, user) {
  const patient = await Patient.findById(patientId);
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }
  assertSameHospital(patient.hospitalId, user);
  return patient;
}

async function assertAbhaIsAvailable(patient, profile) {
  const number = profile.ABHANumber || profile.abhaNumber;
  const address = getAbhaAddress(profile);
  const options = [];
  if (number) options.push({ 'abha.number': String(number) });
  if (address) options.push({ 'abha.address': String(address).toLowerCase() });
  if (!options.length) throw new Error('ABDM response did not contain ABHA identity');

  const duplicate = await Patient.findOne({
    _id: { $ne: patient._id },
    hospitalId: patient.hospitalId,
    $or: options
  }).select('_id patientId uhid');
  if (duplicate) {
    const error = new Error(
      `This ABHA is already associated with patient ${duplicate.patientId || duplicate.uhid}`
    );
    error.statusCode = 409;
    throw error;
  }
}

async function saveVerifiedProfile({ patient, profile, tokens, method, userId }) {
  await assertAbhaIsAvailable(patient, profile);
  const number = profile.ABHANumber || profile.abhaNumber;
  const address = getAbhaAddress(profile);
  const update = {
    'abha.number': number ? displayAbhaNumber(number) : patient.abha?.number,
    'abha.address': address ? String(address).toLowerCase() : patient.abha?.address,
    'abha.status': 'VERIFIED',
    'abha.type': profile.abhaType,
    'abha.kycVerified': true,
    'abha.verificationMethod': method,
    'abha.verifiedAt': new Date(),
    'abha.linkedAt': new Date(),
    'abha.lastLinkedBy': userId,
    'abha.profile.firstName': profile.firstName,
    'abha.profile.middleName': profile.middleName,
    'abha.profile.lastName': profile.lastName,
    'abha.profile.dob': profile.dob,
    'abha.profile.gender': profile.gender,
    'abha.profile.mobileMasked': profile.mobile,
    'abha.profile.districtName': profile.districtName,
    'abha.profile.stateName': profile.stateName,
    'abha.profile.pinCode': profile.pinCode
  };
  Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);
  const saved = await Patient.findByIdAndUpdate(patient._id, { $set: update }, { new: true });
  await storePatientSession({ patient: saved, tokens, updatedBy: userId });
  return saved;
}

function safeAbha(patient) {
  return {
    number: patient.abha?.number,
    address: patient.abha?.address,
    status: patient.abha?.status,
    kycVerified: patient.abha?.kycVerified,
    registrationMode: patient.abha?.registrationMode,
    verificationMethod: patient.abha?.verificationMethod,
    verifiedAt: patient.abha?.verifiedAt,
    profile: patient.abha?.profile
  };
}

async function latestActiveTransaction(patientId, flow) {
  return AbdmIdentityTransaction.findOne({
    patientId,
    flow,
    status: { $in: ['OTP_REQUESTED', 'FAILED'] },
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });
}

exports.requestAadhaarOtp = async (req, res) => {
  try {
    const { patientId, aadhaarNumber } = req.body;
    if (!patientId || !isValidAadhaar(aadhaarNumber)) {
      return res.status(400).json({
        success: false,
        error: 'patientId and a valid 12-digit Aadhaar are required'
      });
    }
    const patient = await ensurePatient(patientId, req.user);
    const previous = await latestActiveTransaction(patient._id, 'AADHAAR_ENROLMENT');
    if (previous) await assertResendAllowed(previous);

    const consent = consentEvidence(req, {
      patientId: patient._id,
      code: 'abha-enrollment',
      version: req.body.consentVersion || '1.4',
      text: req.body.consentText
    });
    const cleanAadhaar = cleanDigits(aadhaarNumber);
    const encryptedAadhaar = await encryptForAbdm(cleanAadhaar);
    const data = await abdmPost('/v3/enrollment/request/otp', {
      txnId: '',
      scope: ['abha-enrol'],
      loginHint: 'aadhaar',
      loginId: encryptedAadhaar,
      otpSystem: 'aadhaar'
    });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'AADHAAR_ENROLMENT',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { aadhaarLast4: cleanAadhaar.slice(-4) }
    });
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          aadhaar_last4: cleanAadhaar.slice(-4),
          'abha.status': 'OTP_SENT',
          'abha.registrationMode': 'aadhaar_otp',
          'abha.lastOtpTxnId': transaction.txnId,
          'abha.lastOtpSentAt': new Date()
        }
      }
    );
    return res.json({ success: true, txnId: transaction.txnId, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.enrolByAadhaarOtp = async (req, res) => {
  let transaction;
  try {
    const { patientId, txnId, otp, mobile } = req.body;
    if (!patientId || !txnId || !otp) {
      return res.status(400).json({
        success: false,
        error: 'patientId, txnId and OTP are required'
      });
    }
    if (mobile && !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'Invalid mobile number' });
    }
    const patient = await ensurePatient(patientId, req.user);
    transaction = await getOwnedTransaction({
      txnId,
      patient,
      userId: req.user._id,
      flows: ['AADHAAR_ENROLMENT']
    });
    const encryptedOtp = await encryptForAbdm(otp);
    const data = await abdmPost('/v3/enrollment/enrol/byAadhaar', {
      authData: {
        authMethods: ['otp'],
        otp: {
          txnId,
          otpValue: encryptedOtp,
          mobile: mobile ? cleanDigits(mobile) : ''
        }
      },
      consent: {
        code: transaction.consent?.code || 'abha-enrollment',
        version: transaction.consent?.version || '1.4'
      }
    });
    const saved = await saveVerifiedProfile({
      patient,
      profile: extractProfile(data),
      tokens: extractTokens(data),
      method: 'ABDM_AADHAAR_OTP',
      userId: req.user._id
    });
    await markCompleted(transaction, { isNew: data.isNew });
    return res.json({
      success: true,
      message: data.message,
      isNew: data.isNew,
      patientId: saved._id,
      abha: safeAbha(saved),
      credential: await getPatientSessionStatus(saved._id)
    });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => {});
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.captureExistingAbha = async (req, res) => {
  try {
    const { patientId, abhaNumber, abhaAddress } = req.body;
    const canonicalNumber = abhaNumber ? displayAbhaNumber(abhaNumber) : undefined;
    if (!patientId || (!canonicalNumber && !abhaAddress)) {
      return res.status(400).json({
        success: false,
        error: 'patientId and ABHA number or address are required'
      });
    }
    const patient = await ensurePatient(patientId, req.user);
    const duplicate = await Patient.findOne({
      _id: { $ne: patient._id },
      hospitalId: patient.hospitalId,
      $or: [
        ...(canonicalNumber ? [{ 'abha.number': canonicalNumber }] : []),
        ...(abhaAddress
          ? [{ 'abha.address': String(abhaAddress).toLowerCase() }]
          : [])
      ]
    });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: 'This ABHA is already associated with another patient'
      });
    }
    const saved = await Patient.findByIdAndUpdate(
      patient._id,
      {
        $set: {
          ...(canonicalNumber ? { 'abha.number': canonicalNumber } : {}),
          ...(abhaAddress
            ? { 'abha.address': String(abhaAddress).toLowerCase() }
            : {}),
          'abha.status': 'VERIFICATION_PENDING',
          'abha.registrationMode': 'manual_capture',
          'abha.kycVerified': false,
          'abha.verificationMethod': 'MANUAL_UNVERIFIED',
          'abha.lastLinkedBy': req.user._id
        }
      },
      { new: true }
    );
    return res.json({
      success: true,
      message: 'ABHA saved as unverified. Complete ABDM verification before linking records.',
      abha: safeAbha(saved)
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message });
  }
};

function normalizeSearchResponse(data) {
  const first = Array.isArray(data) ? data[0] : data;
  return { txnId: first?.txnId, accounts: first?.ABHA || first?.accounts || [] };
}

exports.searchExistingAbhaByMobile = async (req, res) => {
  try {
    const { patientId, mobile } = req.body;
    if (!patientId || !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'Valid patientId and mobile are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    const consent = consentEvidence(req, {
      patientId: patient._id,
      code: 'abha-search',
      version: req.body.consentVersion || '1.0',
      text: req.body.consentText
    });
    const encryptedMobile = await encryptForAbdm(cleanDigits(mobile));
    const data = await abdmPost('/v3/profile/account/abha/search', {
      scope: ['search-abha'],
      mobile: encryptedMobile
    });
    const normalized = normalizeSearchResponse(data);
    const transaction = await createTransaction({
      txnId: normalized.txnId,
      flow: 'EXISTING_ABHA_SEARCH',
      patient,
      userId: req.user._id,
      consent,
      req
    });
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          'abha.status': 'VERIFICATION_PENDING',
          'abha.registrationMode': 'mobile_search',
          'abha.existingSearchTxnId': transaction.txnId
        }
      }
    );
    return res.json({ success: true, txnId: transaction.txnId, accounts: normalized.accounts });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestExistingAbhaOtp = async (req, res) => {
  try {
    const { patientId, txnId, index } = req.body;
    if (!patientId || !txnId || index === undefined || index === null || index === '') {
      return res.status(400).json({ success: false, error: 'patientId, txnId and selected ABHA index are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    const searchTransaction = await getOwnedTransaction({
      txnId,
      patient,
      userId: req.user._id,
      flows: ['EXISTING_ABHA_SEARCH']
    });
    const previousLogin = await AbdmIdentityTransaction.findOne({
      hospitalId: patient.hospitalId,
      patientId: patient._id,
      userId: req.user._id,
      flow: 'EXISTING_ABHA_LOGIN',
      'metadata.searchTxnId': txnId,
      status: { $in: ['OTP_REQUESTED', 'FAILED'] },
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    if (previousLogin) await assertResendAllowed(previousLogin);
    const encryptedIndex = await encryptForAbdm(String(index));
    const data = await abdmPost('/v3/profile/login/request/otp', {
      scope: ['abha-login', 'search-abha', 'mobile-verify'],
      loginHint: 'index',
      loginId: encryptedIndex,
      otpSystem: 'abdm',
      txnId
    });
    const loginTransaction = await createTransaction({
      txnId: data.txnId,
      flow: 'EXISTING_ABHA_LOGIN',
      patient,
      userId: req.user._id,
      consent: searchTransaction.consent,
      selectedIndex: String(index),
      req,
      metadata: { searchTxnId: txnId }
    });
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          'abha.existingLoginTxnId': loginTransaction.txnId,
          'abha.existingSelectedIndex': String(index),
          'abha.status': 'OTP_SENT'
        }
      }
    );
    return res.json({ success: true, txnId: loginTransaction.txnId, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyExistingAbhaOtp = async (req, res) => {
  let transaction;
  try {
    const { patientId, txnId, otp } = req.body;
    if (!patientId || !txnId || !otp) {
      return res.status(400).json({ success: false, error: 'patientId, txnId and OTP are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    transaction = await getOwnedTransaction({
      txnId,
      patient,
      userId: req.user._id,
      flows: ['EXISTING_ABHA_LOGIN']
    });
    const encryptedOtp = await encryptForAbdm(otp);
    const data = await abdmPost('/v3/profile/login/verify', {
      scope: ['abha-login', 'mobile-verify'],
      authData: {
        authMethods: ['otp'],
        otp: { txnId, otpValue: encryptedOtp }
      }
    });
    if (data.authResult && String(data.authResult).toLowerCase() !== 'success') {
      const error = new Error(data.message || 'ABHA OTP verification failed');
      error.statusCode = 400;
      throw error;
    }
    const saved = await saveVerifiedProfile({
      patient,
      profile: extractProfile(data),
      tokens: extractTokens(data),
      method: 'ABDM_EXISTING_ABHA_OTP',
      userId: req.user._id
    });
    await markCompleted(transaction);
    return res.json({
      success: true,
      message: data.message,
      abha: safeAbha(saved),
      credential: await getPatientSessionStatus(saved._id)
    });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => {});
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestMobileOtp = async (req, res) => {
  try {
    const { patientId, mobile, txnId } = req.body;
    if (!patientId || !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'Valid patientId and mobile are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    if (txnId) {
      await getOwnedTransaction({
        txnId,
        patient,
        userId: req.user._id,
        flows: ['AADHAAR_ENROLMENT', 'MOBILE_VERIFICATION']
      });
    }
    const previous = await latestActiveTransaction(
      patient._id,
      'MOBILE_VERIFICATION'
    );
    if (previous) await assertResendAllowed(previous);
    const consent = consentEvidence(req, {
      patientId: patient._id,
      code: 'mobile-verification',
      version: req.body.consentVersion || '1.0',
      text: req.body.consentText
    });
    const data = await abdmPost('/v3/enrollment/request/otp', {
      txnId: txnId || '',
      scope: ['abha-enrol', 'mobile-verify'],
      loginHint: 'mobile',
      loginId: await encryptForAbdm(cleanDigits(mobile)),
      otpSystem: 'abdm'
    });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'MOBILE_VERIFICATION',
      patient,
      userId: req.user._id,
      consent,
      req
    });
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          'abha.mobileVerificationTxnId': transaction.txnId,
          'abha.mobileVerificationStatus': 'otp_sent'
        }
      }
    );
    return res.json({ success: true, txnId: transaction.txnId, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyMobileOtp = async (req, res) => {
  let transaction;
  try {
    const { patientId, txnId, otp } = req.body;
    if (!patientId || !txnId || !otp) {
      return res.status(400).json({ success: false, error: 'patientId, txnId and OTP are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    transaction = await getOwnedTransaction({
      txnId,
      patient,
      userId: req.user._id,
      flows: ['MOBILE_VERIFICATION']
    });
    const data = await abdmPost('/v3/enrollment/auth/byAbdm', {
      scope: ['abha-enrol', 'mobile-verify'],
      authData: {
        authMethods: ['otp'],
        otp: {
          timeStamp: new Date().toISOString(),
          txnId,
          otpValue: await encryptForAbdm(otp)
        }
      }
    });
    await Patient.updateOne(
      { _id: patient._id },
      {
        $set: {
          'abha.mobileVerificationStatus': 'verified',
          'abha.mobileVerifiedAt': new Date()
        }
      }
    );
    await markCompleted(transaction);
    return res.json({ success: true, message: data.message || 'Mobile verified' });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => {});
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

async function xTokenForPatient(patientId) {
  // Never accept a browser-supplied ABDM user token. Patient tokens are resolved
  // only from the hospital's encrypted credential store after tenant ownership checks.
  return getActiveAccessToken(patientId);
}

exports.getQrCode = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const token = await xTokenForPatient(patient._id);
    const response = await abdmGet(
      '/v3/profile/account/qrCode',
      { 'X-token': `Bearer ${token}` },
      'buffer'
    );
    res.setHeader('Content-Type', response.contentType);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return res.send(response.buffer);
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.getAbhaCard = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const token = await xTokenForPatient(patient._id);
    const response = await abdmGet(
      '/v3/profile/account/abha-card',
      { 'X-token': `Bearer ${token}` },
      'buffer'
    );
    res.setHeader('Content-Type', response.contentType);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="abha-card-${patient.patientId || patient._id}.pdf"`
    );
    return res.send(response.buffer);
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.getAddressSuggestions = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const token = await xTokenForPatient(patient._id);
    const data = await abdmPost(
      '/v3/profile/account/abha-address/suggestion',
      req.body.payload || {},
      { 'X-token': `Bearer ${token}` }
    );
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.validateAddress = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const token = await xTokenForPatient(patient._id);
    const data = await abdmPost(
      '/v3/profile/account/abha-address/validate',
      { abhaAddress: req.body.abhaAddress },
      { 'X-token': `Bearer ${token}` }
    );
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.createAddress = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const token = await xTokenForPatient(patient._id);
    const data = await abdmPost(
      '/v3/profile/account/abha-address',
      req.body.payload || { abhaAddress: req.body.abhaAddress },
      { 'X-token': `Bearer ${token}` }
    );
    const address =
      getAbhaAddress(data) ||
      req.body.abhaAddress ||
      data.abhaAddress;
    if (address) {
      const duplicate = await Patient.findOne({
        _id: { $ne: patient._id },
        hospitalId: patient.hospitalId,
        'abha.address': String(address).toLowerCase()
      });
      if (duplicate) throw new Error('ABHA address is already linked to another patient');
      patient.abha.address = String(address).toLowerCase();
      await patient.save();
    }
    return res.json({ success: true, data, abha: safeAbha(patient) });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.getPatientAbha = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    return res.json({
      success: true,
      patientId: patient._id,
      abha: safeAbha(patient),
      credential: await getPatientSessionStatus(patient._id)
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message });
  }
};

function patientDisplayName(patient) {
  return [
    patient.salutation,
    patient.first_name,
    patient.middle_name,
    patient.last_name
  ]
    .filter(Boolean)
    .join(' ');
}

exports.searchPatientsByAbha = async (req, res) => {
  try {
    const hospitalId = assertUserHospital(req.user);
    const { query, status, limit = 20 } = req.query;
    const filter = { hospitalId };
    const searchConditions = patientSearchConditions(query);
    if (searchConditions.length) filter.$or = searchConditions;
    if (status) filter['abha.status'] = abhaStatusFilter(status);

    const parsedLimit = Number.parseInt(limit, 10);
    const safeLimit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 20, 1), 100);
    const patients = await Patient.find(filter)
      .select([
        'patientId',
        'uhid',
        'salutation',
        'first_name',
        'middle_name',
        'last_name',
        'phone',
        'gender',
        'dob',
        'patient_type',
        'registered_at',
        'hospitalId',
        'abha.number',
        'abha.address',
        'abha.status',
        'abha.kycVerified',
        'abha.registrationMode',
        'abha.verificationMethod',
        'abha.verifiedAt',
        'abha.profile'
      ].join(' '))
      .sort({ registered_at: -1 })
      .limit(safeLimit)
      .lean();

    return res.json({
      success: true,
      count: patients.length,
      patients: patients.map((patient) => ({
        _id: patient._id,
        patientId: patient.patientId,
        uhid: patient.uhid,
        name: patientDisplayName(patient),
        first_name: patient.first_name,
        middle_name: patient.middle_name,
        last_name: patient.last_name,
        phone: patient.phone,
        gender: patient.gender,
        dob: patient.dob,
        patient_type: patient.patient_type,
        registered_at: patient.registered_at,
        hospitalId: patient.hospitalId,
        abha: safeAbha(patient)
      }))
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message });
  }
};

const RECORD_MODELS = {
  appointment: { model: Appointment, patientField: 'patient_id' },
  ipd_admission: { model: IPDAdmission, patientField: 'patientId' },
  prescription: { model: Prescription, patientField: 'patient_id' },
  lab_report: { model: LabReport, patientField: 'patient_id' },
  radiology_report: { model: RadiologyRequest, patientField: 'patientId' },
  discharge_summary: { model: DischargeSummary, patientField: 'patientId' }
};

async function linkOneRecord({
  patient,
  recordType,
  recordId,
  ehrBundleId,
  source = 'manual'
}) {
  const definition = RECORD_MODELS[recordType];
  if (!definition) {
    const error = new Error(`Unsupported recordType: ${recordType}`);
    error.statusCode = 400;
    throw error;
  }
  const record = await definition.model.findById(recordId);
  if (!record) {
    const error = new Error(`${recordType} not found`);
    error.statusCode = 404;
    throw error;
  }
  if (String(record[definition.patientField]) !== String(patient._id)) {
    const error = new Error(`${recordType} does not belong to this patient`);
    error.statusCode = 403;
    throw error;
  }
  record.abdmRecordLink = {
    patientId: patient._id,
    abhaNumber: patient.abha?.number,
    abhaAddress: patient.abha?.address,
    status:
      patient.abha?.status === 'VERIFIED'
        ? 'LOCAL_RECORD_READY'
        : 'VERIFICATION_PENDING',
    linkedAt: new Date(),
    source,
    ehrBundleId
  };
  await record.save();
  return record;
}

exports.linkRecord = async (req, res) => {
  try {
    const { patientId, recordType, recordId, ehrBundleId } = req.body;
    if (!patientId || !recordType || !recordId) {
      return res.status(400).json({
        success: false,
        error: 'patientId, recordType and recordId are required'
      });
    }
    const patient = await ensurePatient(patientId, req.user);
    const record = await linkOneRecord({
      patient,
      recordType,
      recordId,
      ehrBundleId,
      source: 'manual'
    });
    await Patient.updateOne(
      { _id: patient._id, hospitalId: patient.hospitalId },
      {
        $addToSet: {
          'abha.recordLinks': {
            recordType,
            recordId,
            ehrBundleId,
            linkedAt: new Date(),
            status: record.abdmRecordLink.status
          }
        }
      }
    );
    return res.json({
      success: true,
      recordType,
      recordId,
      link: record.abdmRecordLink
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};

exports.linkAllPatientRecords = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const results = [];
    for (const [recordType, definition] of Object.entries(RECORD_MODELS)) {
      // eslint-disable-next-line no-await-in-loop
      const records = await definition.model
        .find({ [definition.patientField]: patient._id })
        .select('_id');
      for (const record of records) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await linkOneRecord({
            patient,
            recordType,
            recordId: record._id,
            source: 'bulk_patient_link'
          });
          results.push({
            recordType,
            recordId: record._id,
            status: 'LOCAL_RECORD_READY'
          });
        } catch (error) {
          results.push({
            recordType,
            recordId: record._id,
            status: 'FAILED',
            error: error.message
          });
        }
      }
    }
    await Patient.updateOne(
      { _id: patient._id, hospitalId: patient.hospitalId },
      { $set: { 'abha.lastRecordLinkSyncAt': new Date() } }
    );
    return res.json({ success: true, count: results.length, results });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};

exports.generateEhr = async (req, res) => {
  try {
    const { patientId, bundleType = 'EMR_SUMMARY' } = req.body;
    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'patientId is required'
      });
    }
    const patient = await ensurePatient(patientId, req.user);
    const { ehrBundle, bundle } = await generateEhrBundle(patient._id, {
      bundleType,
      createdBy: req.user?._id
    });
    await Patient.updateOne(
      { _id: patient._id, hospitalId: patient.hospitalId },
      {
        $set: {
          'abha.lastEhrBundleId': ehrBundle._id,
          'abha.lastEhrGeneratedAt': new Date()
        }
      }
    );
    return res.json({
      success: true,
      ehrBundleId: ehrBundle._id,
      recordCounts: ehrBundle.recordCounts,
      bundle
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getPatientEhrBundles = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const bundles = await EHRBundle.find({
      hospitalId: patient.hospitalId,
      patientId: patient._id
    })
      .select('-bundle.entry.resource.content')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    return res.json({ success: true, bundles });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};

exports.getEhrBundle = async (req, res) => {
  try {
    const bundle = await EHRBundle.findOne({
      _id: req.params.bundleId,
      hospitalId: assertUserHospital(req.user)
    }).lean();
    if (!bundle) {
      return res.status(404).json({
        success: false,
        error: 'EHR bundle not found'
      });
    }
    await ensurePatient(bundle.patientId, req.user);
    return res.json({ success: true, ehrBundle: bundle });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};
