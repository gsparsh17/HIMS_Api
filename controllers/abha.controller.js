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
const {
  encryptForAbdm,
  abdmPost,
  abdmGet,
  abdmPatch
} = require('../services/abdm.service');
const {
  storePatientSession,
  getActiveAccessToken,
  getPatientSessionStatus,
  withPatientAccessToken,
  clearPatientSession
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
const { assertPatientIdentityMatch } = require('../services/abdmIdentityMatch.service');
const { assertAbdmExchangeEligible } = require('../services/abdmExchangeEligibility.service');
const { encryptJson, decryptJson } = require('../services/abdmVault.service');

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
  if (data.tokens && typeof data.tokens === 'object') return data.tokens;
  if (data.token && typeof data.token === 'object') return data.token;
  return {
    token: typeof data.token === 'string' ? data.token : data.accessToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
    refreshExpiresIn: data.refreshExpiresIn,
    scope: data.scope
  };
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
  const rawNumber = profile.ABHANumber || profile.abhaNumber;
  const number = rawNumber ? displayAbhaNumber(rawNumber) : undefined;
  const address = getAbhaAddress(profile);
  const options = [];
  if (number) options.push({ 'abha.number': number });
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

function registrationModeForMethod(method, currentMode) {
  const value = String(method || '').toUpperCase();
  const current = currentMode && currentMode !== 'none' ? currentMode : null;
  if (value.includes('DRIVING_LICENCE')) return 'driving_licence';
  if (value.includes('FINGERPRINT')) return 'fingerprint';
  if (value.includes('FACE')) return 'face';
  if (value.includes('IRIS')) return 'iris';
  if (value.includes('PASSWORD')) return 'password';
  if (value.includes('ADDRESS')) return 'abha_address';
  if (value.includes('AADHAAR')) return current || 'aadhaar_otp';
  if (value.includes('MOBILE') || value.includes('EXISTING')) {
    return current || 'mobile_search';
  }
  return current || 'none';
}

async function saveVerifiedProfile({ patient, profile, tokens, method, userId }) {
  await assertAbhaIsAvailable(patient, profile);
  let assessment;
  try {
    assessment = assertPatientIdentityMatch(patient, profile);
  } catch (error) {
    const details = error.details || {};
    await Patient.updateOne(
      { _id: patient._id, hospitalId: patient.hospitalId },
      {
        $set: {
          'abha.status': 'IDENTITY_MISMATCH',
          'abha.kycVerified': false,
          'abha.identityReconciliation.status': 'MISMATCH',
          'abha.identityReconciliation.checkedAt': new Date(),
          'abha.identityReconciliation.method': method,
          'abha.identityReconciliation.score': details.score,
          'abha.identityReconciliation.matchedFields': details.matchedFields || [],
          'abha.identityReconciliation.mismatchedFields': details.mismatchedFields || [],
          'abha.identityReconciliation.unavailableFields': details.unavailableFields || []
        }
      }
    );
    throw error;
  }

  const number = profile.ABHANumber || profile.abhaNumber;
  const address = getAbhaAddress(profile);
  const update = {
    'abha.number': number ? displayAbhaNumber(number) : patient.abha?.number,
    'abha.address': address ? String(address).toLowerCase() : patient.abha?.address,
    'abha.status': 'VERIFIED',
    'abha.type': profile.abhaType,
    'abha.kycVerified': true,
    'abha.registrationMode': registrationModeForMethod(
      method,
      patient.abha?.registrationMode
    ),
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
    'abha.profile.pinCode': profile.pinCode,
    'abha.identityReconciliation.status': 'MATCHED',
    'abha.identityReconciliation.checkedAt': new Date(),
    'abha.identityReconciliation.method': method,
    'abha.identityReconciliation.score': assessment.score,
    'abha.identityReconciliation.matchedFields': assessment.matchedFields,
    'abha.identityReconciliation.mismatchedFields': [],
    'abha.identityReconciliation.unavailableFields': assessment.unavailableFields,
    'abha.identityReconciliation.profileFingerprint': assessment.profileFingerprint
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
    profile: patient.abha?.profile,
    identityReconciliation: patient.abha?.identityReconciliation
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
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
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

exports.requestExistingAbhaFace = async (req, res) => {
  try {
    const { patientId, txnId, index } = req.body;
    if (!patientId || !txnId || index === undefined || index === null || index === '') {
      return res.status(400).json({ success: false, error: 'patientId, search txnId and selected ABHA index are required' });
    }
    const patient = await ensurePatient(patientId, req.user);
    const searchTransaction = await getOwnedTransaction({ txnId, patient, userId: req.user._id, flows: ['EXISTING_ABHA_SEARCH'] });
    const data = await abdmPost('/v3/profile/login/request/otp', {
      scope: ['abha-login', 'search-abha', 'face-auth'],
      loginHint: 'index',
      loginId: await encryptForAbdm(String(index)),
      otpSystem: 'aadhaar',
      txnId
    });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'FACE_LOGIN',
      patient,
      userId: req.user._id,
      consent: searchTransaction.consent,
      selectedIndex: String(index),
      req,
      metadata: { searchTxnId: txnId, captureScope: ['abha-enrol', 'face-verify'], loginScope: ['abha-login', 'aadhaar-face-verify'], qrFlow: true }
    });
    const qrUrl = `${String(process.env.ABDM_PHR_FACE_AUTH_URL || 'https://phrsbx.abdm.gov.in/face-auth').replace(/\/$/, '')}?txnId=${encodeURIComponent(transaction.txnId)}`;
    return res.json({ success: true, txnId: transaction.txnId, qrUrl, message: data.message, expiresIn: 600 });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.captureExistingAbhaFace = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['FACE_LOGIN'] });
    const data = await abdmPost('/v3/enrollment/enrol/capturePID', {
      scope: transaction.metadata?.captureScope || ['abha-enrol', 'face-verify'],
      txnId: transaction.txnId
    });
    const status = String(data.status || '').toUpperCase();
    if (status === 'FAILED') await recordAttempt(transaction, new Error(data.message || 'Face authentication failed')).catch(() => {});
    return res.json({ success: true, txnId: transaction.txnId, status, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyExistingAbhaFace = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['FACE_LOGIN'] });
    const capture = await abdmPost('/v3/enrollment/enrol/capturePID', {
      scope: transaction.metadata?.captureScope || ['abha-enrol', 'face-verify'],
      txnId: transaction.txnId
    });
    if (String(capture.status || '').toUpperCase() !== 'COMPLETE') {
      return res.status(409).json({ success: false, error: 'Face authentication is not complete in the ABHA App', status: capture.status, message: capture.message });
    }
    const data = await abdmPost('/v3/profile/login/verify', {
      scope: transaction.metadata?.loginScope || ['abha-login', 'aadhaar-face-verify'],
      authData: { authMethods: ['face_auth'], face: { txnId: transaction.txnId } }
    });
    const profile = extractProfile(data);
    const tokens = extractTokens(data);
    if (!(profile.ABHANumber || profile.abhaNumber || getAbhaAddress(profile)) || !tokens.token) {
      const error = new Error('ABDM Face Auth completed but did not return a final ABHA profile/token');
      error.statusCode = 502;
      error.details = data;
      throw error;
    }
    const saved = await saveVerifiedProfile({ patient, profile, tokens, method: 'ABDM_FACE_QR_LOGIN', userId: req.user._id });
    await markCompleted(transaction, { faceQr: true });
    return res.json({ success: true, message: data.message || 'Existing ABHA verified with Face Authentication', abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => {});
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
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
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
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

async function patientProfileRequest(patient, operation, options = {}) {
  if (options.requireEligible !== false) assertAbdmExchangeEligible(patient);
  return withPatientAccessToken(
    patient._id,
    (token) => operation(token),
    { updatedBy: options.updatedBy }
  );
}

exports.getQrCode = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const response = await patientProfileRequest(
      patient,
      (token) =>
        abdmGet(
          '/v3/profile/account/qrCode',
          { 'X-token': `Bearer ${token}` },
          'buffer'
        ),
      { updatedBy: req.user._id }
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
    const response = await patientProfileRequest(
      patient,
      (token) =>
        abdmGet(
          '/v3/profile/account/abha-card',
          { 'X-token': `Bearer ${token}` },
          'buffer'
        ),
      { updatedBy: req.user._id }
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

exports.getProfile = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const data = await patientProfileRequest(
      patient,
      (token) =>
        abdmGet('/v3/profile/account', {
          'X-token': `Bearer ${token}`
        }),
      { updatedBy: req.user._id, requireEligible: false }
    );
    const profile = extractProfile(data);
    const assessment = assertPatientIdentityMatch(patient, profile);
    await Patient.updateOne(
      { _id: patient._id, hospitalId: patient.hospitalId },
      {
        $set: {
          'abha.profile.firstName': profile.firstName,
          'abha.profile.middleName': profile.middleName,
          'abha.profile.lastName': profile.lastName,
          'abha.profile.dob': profile.dob,
          'abha.profile.gender': profile.gender,
          'abha.profile.mobileMasked': profile.mobile,
          'abha.profile.districtName': profile.districtName,
          'abha.profile.stateName': profile.stateName,
          'abha.profile.pinCode': profile.pinCode,
          'abha.identityReconciliation.status': 'MATCHED',
          'abha.identityReconciliation.checkedAt': new Date(),
          'abha.identityReconciliation.method': 'ABDM_PROFILE_REFRESH',
          'abha.identityReconciliation.score': assessment.score,
          'abha.identityReconciliation.matchedFields': assessment.matchedFields,
          'abha.identityReconciliation.mismatchedFields': [],
          'abha.identityReconciliation.unavailableFields': assessment.unavailableFields,
          'abha.identityReconciliation.profileFingerprint': assessment.profileFingerprint
        }
      }
    );
    return res.json({ success: true, profile });
  } catch (error) {
    if (error.code === 'ABHA_IDENTITY_MISMATCH') {
      await Patient.updateOne(
        { _id: req.params.patientId },
        {
          $set: {
            'abha.status': 'IDENTITY_MISMATCH',
            'abha.kycVerified': false,
            'abha.identityReconciliation.status': 'MISMATCH',
            'abha.identityReconciliation.checkedAt': new Date(),
            'abha.identityReconciliation.method': 'ABDM_PROFILE_REFRESH',
            'abha.identityReconciliation.matchedFields': error.details?.matchedFields || [],
            'abha.identityReconciliation.mismatchedFields': error.details?.mismatchedFields || [],
            'abha.identityReconciliation.unavailableFields': error.details?.unavailableFields || [],
            'abha.identityReconciliation.score': error.details?.score
          }
        }
      ).catch(() => { });
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.logoutProfile = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    await patientProfileRequest(
      patient,
      (token) =>
        abdmGet('/v3/profile/account/request/logout', {
          'X-token': `Bearer ${token}`
        }),
      { updatedBy: req.user._id, requireEligible: false }
    );
    await clearPatientSession(patient._id);
    return res.json({ success: true, message: 'ABHA profile session logged out' });
  } catch (error) {
    if (error.code === 'ABHA_REAUTH_REQUIRED') {
      await clearPatientSession(req.params.patientId).catch(() => { });
      return res.json({ success: true, message: 'ABHA profile session was already expired' });
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

async function ownedEnrollmentTransaction(req, patient) {
  const txnId = req.body.txnId || patient.abha?.lastOtpTxnId;
  if (!txnId) {
    const error = new Error('txnId is required for ABHA address enrollment');
    error.statusCode = 400;
    throw error;
  }
  const transaction = await getOwnedTransaction({
    txnId,
    patient,
    userId: req.user._id,
    flows: ['AADHAAR_ENROLMENT', 'BIOMETRIC_ENROLMENT']
  });
  return { txnId, transaction };
}

exports.getAddressSuggestions = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const { txnId } = await ownedEnrollmentTransaction(req, patient);
    const data = await abdmGet('/v3/enrollment/enrol/suggestion', {
      Transaction_Id: txnId
    });
    return res.json({ success: true, txnId, suggestions: data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.validateAddress = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const { txnId } = await ownedEnrollmentTransaction(req, patient);
    const requested = String(req.body.abhaAddress || '').trim().toLowerCase();
    if (!requested) return res.status(400).json({ success: false, error: 'abhaAddress is required' });
    const data = await abdmGet('/v3/enrollment/enrol/suggestion', {
      Transaction_Id: txnId
    });
    const values = (Array.isArray(data) ? data : data?.suggestions || data?.abhaAddress || [])
      .flatMap((item) => (typeof item === 'string' ? [item] : [item?.abhaAddress, item?.address]))
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return res.status(values.includes(requested) ? 200 : 422).json({
      success: values.includes(requested),
      valid: values.includes(requested),
      txnId,
      suggestions: data
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.createAddress = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const { txnId } = await ownedEnrollmentTransaction(req, patient);
    const requested = String(req.body.abhaAddress || '').trim().toLowerCase();
    if (!requested) return res.status(400).json({ success: false, error: 'abhaAddress is required' });
    const data = await abdmPost('/v3/enrollment/enrol/abha-address', {
      txnId,
      abhaAddress: requested,
      preferred: Number(req.body.preferred ?? 1)
    });
    const address = getAbhaAddress(data) || requested;
    const duplicate = await Patient.findOne({
      _id: { $ne: patient._id },
      hospitalId: patient.hospitalId,
      'abha.address': String(address).toLowerCase()
    });
    if (duplicate) {
      const error = new Error('ABHA address is already linked to another patient');
      error.statusCode = 409;
      throw error;
    }
    patient.abha.address = String(address).toLowerCase();
    await patient.save();
    return res.json({ success: true, data, abha: safeAbha(patient) });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestEmailVerification = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'A valid email is required' });
    }
    const encryptedEmail = await encryptForAbdm(email);
    const data = await patientProfileRequest(
      patient,
      (token) =>
        abdmPost(
          '/v3/profile/account/request/emailVerificationLink',
          {
            scope: ['abha-profile', 'email-link-verify'],
            loginHint: 'email',
            loginId: encryptedEmail,
            otpSystem: 'abdm'
          },
          { 'X-token': `Bearer ${token}` }
        ),
      { updatedBy: req.user._id }
    );
    return res.json({ success: true, data });
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


const LOGIN_MODE_CONFIG = Object.freeze({
  mobile_otp: {
    flow: 'GENERIC_ABHA_LOGIN',
    scope: ['abha-login', 'mobile-verify'],
    loginHint: 'mobile',
    otpSystem: 'abdm',
    valueField: 'mobile'
  },
  abha_otp: {
    flow: 'GENERIC_ABHA_LOGIN',
    scope: ['abha-login', 'mobile-verify'],
    loginHint: 'abha-number',
    otpSystem: 'abdm',
    valueField: 'abhaNumber'
  },
  abha_aadhaar_otp: {
    flow: 'GENERIC_ABHA_LOGIN',
    scope: ['abha-login', 'aadhaar-verify'],
    loginHint: 'abha-number',
    otpSystem: 'aadhaar',
    valueField: 'abhaNumber'
  },
  aadhaar_otp: {
    flow: 'GENERIC_ABHA_LOGIN',
    scope: ['abha-login', 'aadhaar-verify'],
    loginHint: 'aadhaar',
    otpSystem: 'aadhaar',
    valueField: 'aadhaarNumber'
  },
  face: {
    flow: 'FACE_LOGIN',
    scope: ['abha-login', 'aadhaar-face-verify'],
    loginHint: 'abha-number',
    otpSystem: 'aadhaar',
    valueField: 'abhaNumber'
  },
  fingerprint: {
    flow: 'FINGERPRINT_LOGIN',
    scope: ['abha-login', 'aadhaar-bio-verify'],
    loginHint: 'abha-number',
    otpSystem: 'aadhaar',
    valueField: 'abhaNumber'
  },
  iris: {
    flow: 'IRIS_LOGIN',
    scope: ['abha-login', 'aadhaar-iris-verify'],
    loginHint: 'abha-number',
    otpSystem: 'aadhaar',
    valueField: 'abhaNumber',
    requestPath: '/v3/login/request/otp'
  }
});

function loginMode(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function requireOpaquePid(value, field = 'pid') {
  const text = String(value || '').trim();
  if (!text || text.length < 20 || text.length > 2_000_000) {
    const error = new Error(`${field} is required and must contain valid RD-service PID data`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function consentForIdentity(req, patient, code = 'abha-login', version = '1.0') {
  return consentEvidence(req, {
    patientId: patient._id,
    code,
    version: req.body.consentVersion || version,
    text: req.body.consentText
  });
}

exports.requestAdvancedLogin = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const mode = loginMode(req.body.mode);
    const config = LOGIN_MODE_CONFIG[mode];
    if (mode === 'face') {
      return res.status(410).json({ success: false, error: 'Legacy browser PID face login is disabled. Use mobile search + ABHA App Face Auth QR.' });
    }
    if (!config) {
      return res.status(400).json({ success: false, error: 'Unsupported ABHA login mode' });
    }
    const rawValue = req.body[config.valueField] ||
      (config.valueField === 'abhaNumber' ? patient.abha?.number : undefined);
    if (!rawValue) {
      return res.status(400).json({ success: false, error: `${config.valueField} is required` });
    }
    if (config.valueField === 'mobile' && !isValidMobile(rawValue)) {
      return res.status(400).json({ success: false, error: 'A valid mobile number is required' });
    }
    if (config.valueField === 'aadhaarNumber' && !isValidAadhaar(rawValue)) {
      return res.status(400).json({ success: false, error: 'A valid Aadhaar number is required' });
    }
    const consent = consentForIdentity(req, patient);
    const encryptedLoginId = await encryptForAbdm(
      config.valueField === 'mobile' || config.valueField === 'aadhaarNumber'
        ? cleanDigits(rawValue)
        : displayAbhaNumber(rawValue)
    );
    const data = await abdmPost(
      config.requestPath || '/v3/profile/login/request/otp',
      {
        scope: config.scope,
        loginHint: config.loginHint,
        loginId: encryptedLoginId,
        otpSystem: config.otpSystem
      }
    );
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: config.flow,
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { mode, scope: config.scope }
    });
    return res.json({ success: true, txnId: transaction.txnId, mode, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyAdvancedLogin = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const mode = loginMode(req.body.mode);
    const config = LOGIN_MODE_CONFIG[mode];
    if (mode === 'face') {
      return res.status(410).json({ success: false, error: 'Legacy browser PID face login is disabled. Use mobile search + ABHA App Face Auth QR.' });
    }
    if (!config || !req.body.txnId) {
      return res.status(400).json({ success: false, error: 'A valid mode and txnId are required' });
    }
    transaction = await getOwnedTransaction({
      txnId: req.body.txnId,
      patient,
      userId: req.user._id,
      flows: [config.flow]
    });

    let authData;
    if (mode.endsWith('_otp') || ['mobile_otp', 'abha_otp', 'abha_aadhaar_otp', 'aadhaar_otp'].includes(mode)) {
      if (!req.body.otp) return res.status(400).json({ success: false, error: 'OTP is required' });
      authData = {
        authMethods: ['otp'],
        otp: { txnId: transaction.txnId, otpValue: await encryptForAbdm(req.body.otp) }
      };
    } else if (mode === 'face') {
      authData = { authMethods: ['face'], face: { txnId: transaction.txnId, faceAuthPid: requireOpaquePid(req.body.pid, 'face PID') } };
    } else if (mode === 'fingerprint') {
      authData = { authMethods: ['bio'], bio: { txnId: transaction.txnId, fingerPrintAuthPid: requireOpaquePid(req.body.pid, 'fingerprint PID') } };
    } else if (mode === 'iris') {
      authData = { authMethods: ['iris'], iris: { txnId: transaction.txnId, irisAuthPid: requireOpaquePid(req.body.pid, 'iris PID') } };
    }

    const data = await abdmPost('/v3/profile/login/verify', {
      scope: config.scope,
      authData
    });
    if (data.authResult && String(data.authResult).toLowerCase() !== 'success') {
      const error = new Error(data.message || 'ABHA authentication failed');
      error.statusCode = 400;
      throw error;
    }

    const profile = extractProfile(data);
    const tokens = extractTokens(data);
    if ((profile.ABHANumber || profile.abhaNumber || getAbhaAddress(profile)) && tokens.token) {
      const saved = await saveVerifiedProfile({
        patient,
        profile,
        tokens,
        method: `ABDM_${mode.toUpperCase()}`,
        userId: req.user._id
      });
      await markCompleted(transaction, { mode });
      return res.json({ success: true, message: data.message, abha: safeAbha(saved) });
    }

    const intermediateToken = data.token || data.tToken || data.tokens?.token;
    const accounts = data.accounts || data.ABHA || data.abha || [];
    if (!intermediateToken || !Array.isArray(accounts)) {
      throw new Error('ABDM authentication response did not contain a profile or user-selection token');
    }
    transaction.status = 'OTP_VERIFIED';
    transaction.metadata = {
      ...(transaction.metadata || {}),
      intermediateToken: encryptJson(
        { token: intermediateToken },
        `abdm-identity-intermediate:${transaction.txnId}`
      ),
      accountCount: accounts.length
    };
    await transaction.save();
    return res.json({ success: true, selectionRequired: true, txnId: transaction.txnId, accounts });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.completeAdvancedLoginUser = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({
      txnId: req.body.txnId,
      patient,
      userId: req.user._id,
      flows: ['GENERIC_ABHA_LOGIN', 'FACE_LOGIN', 'FINGERPRINT_LOGIN', 'IRIS_LOGIN']
    });
    const encrypted = transaction.metadata?.intermediateToken;
    if (!encrypted) return res.status(409).json({ success: false, error: 'No pending ABDM user selection exists' });
    const { token } = decryptJson(encrypted, `abdm-identity-intermediate:${transaction.txnId}`);
    const abhaNumber = displayAbhaNumber(req.body.abhaNumber);
    if (!abhaNumber) return res.status(400).json({ success: false, error: 'abhaNumber is required' });
    const data = await abdmPost(
      '/v3/profile/login/verify/user',
      { ABHANumber: abhaNumber, txnId: transaction.txnId },
      { 'T-token': `Bearer ${token}` }
    );
    const saved = await saveVerifiedProfile({
      patient,
      profile: extractProfile(data),
      tokens: extractTokens(data),
      method: 'ABDM_USER_SELECTION',
      userId: req.user._id
    });
    await markCompleted(transaction, { selectedAbhaNumber: abhaNumber });
    return res.json({ success: true, abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.searchPasswordLogin = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const abhaNumber = displayAbhaNumber(req.body.abhaNumber || patient.abha?.number);
    if (!abhaNumber) return res.status(400).json({ success: false, error: 'abhaNumber is required' });
    const consent = consentForIdentity(req, patient);
    const data = await abdmPost('/v3/profile/login/search', { ABHANumber: abhaNumber });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'PASSWORD_LOGIN',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { abhaNumber }
    });
    return res.json({ success: true, txnId: transaction.txnId, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyPasswordLogin = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    if (!req.body.password) return res.status(400).json({ success: false, error: 'password is required' });
    transaction = await getOwnedTransaction({
      txnId: req.body.txnId,
      patient,
      userId: req.user._id,
      flows: ['PASSWORD_LOGIN']
    });
    const abhaNumber = transaction.metadata?.abhaNumber || displayAbhaNumber(req.body.abhaNumber);
    const data = await abdmPost('/v3/profile/login/verify', {
      scope: ['abha-login', 'password-verify'],
      authData: {
        authMethods: ['password'],
        password: {
          ABHANumber: abhaNumber,
          password: await encryptForAbdm(req.body.password)
        }
      }
    });
    const saved = await saveVerifiedProfile({
      patient,
      profile: extractProfile(data),
      tokens: extractTokens(data),
      method: 'ABDM_PASSWORD',
      userId: req.user._id
    });
    await markCompleted(transaction);
    return res.json({ success: true, abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestDocumentEnrollmentOtp = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    if (!isValidMobile(req.body.mobile)) return res.status(400).json({ success: false, error: 'A valid mobile is required' });
    const consent = consentForIdentity(req, patient, 'abha-enrollment', '1.4');
    const data = await abdmPost('/v3/enrollment/request/otp', {
      scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
      loginHint: 'mobile',
      loginId: await encryptForAbdm(cleanDigits(req.body.mobile)),
      otpSystem: 'abdm'
    });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'DOCUMENT_ENROLMENT',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { documentType: 'DRIVING_LICENCE' }
    });
    return res.json({ success: true, txnId: transaction.txnId, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyDocumentEnrollmentOtp = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['DOCUMENT_ENROLMENT'] });
    const data = await abdmPost('/v3/enrollment/auth/byAbdm', {
      scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
      authData: { authMethods: ['otp'], otp: { timeStamp: new Date().toISOString(), txnId: transaction.txnId, otpValue: await encryptForAbdm(req.body.otp) } }
    });
    transaction.status = 'OTP_VERIFIED';
    transaction.metadata = { ...(transaction.metadata || {}), verifiedTxnId: data.txnId || transaction.txnId };
    await transaction.save();
    return res.json({ success: true, txnId: data.txnId || transaction.txnId, message: data.message });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.enrolByDocument = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['DOCUMENT_ENROLMENT'] });
    if (transaction.status !== 'OTP_VERIFIED') return res.status(409).json({ success: false, error: 'Mobile OTP must be verified first' });
    const document = req.body.document || {};
    const required = ['documentId', 'firstName', 'lastName', 'dob', 'gender', 'frontSidePhoto', 'backSidePhoto', 'address', 'state', 'district', 'pinCode'];
    const missing = required.filter((field) => !document[field]);
    if (missing.length) return res.status(400).json({ success: false, error: `Missing document fields: ${missing.join(', ')}` });
    const data = await abdmPost('/v3/enrollment/enrol/byDocument', {
      txnId: transaction.metadata?.verifiedTxnId || transaction.txnId,
      documentType: 'DRIVING_LICENCE',
      ...document,
      consent: { code: transaction.consent?.code || 'abha-enrollment', version: transaction.consent?.version || '1.4' }
    });
    const saved = await saveVerifiedProfile({ patient, profile: extractProfile(data), tokens: extractTokens(data), method: 'ABDM_DRIVING_LICENCE', userId: req.user._id });
    await markCompleted(transaction);
    return res.json({ success: true, message: data.message, abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.initBiometricEnrollment = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const method = loginMode(req.body.method || 'face');
    if (!['face', 'fingerprint', 'iris'].includes(method)) return res.status(400).json({ success: false, error: 'method must be face, fingerprint or iris' });
    const consent = consentForIdentity(req, patient, 'abha-enrollment', '1.4');
    const initScope = ['abha-enrol', method === 'face' ? 'face-auth' : method === 'fingerprint' ? 'bio-verify' : 'iris-verify'];
    const captureScope = ['abha-enrol', method === 'face' ? 'face-verify' : method === 'fingerprint' ? 'bio-verify' : 'iris-verify'];
    const data = await abdmPost('/v3/enrollment/enrol/auth/init', { scope: initScope });
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'BIOMETRIC_ENROLMENT',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { method, initScope, captureScope }
    });
    return res.json({
      success: true,
      txnId: transaction.txnId,
      qrUrl: method === 'face'
        ? `${String(process.env.ABDM_PHR_FACE_AUTH_URL || 'https://phrsbx.abdm.gov.in/face-auth').replace(/\/$/, '')}?txnId=${encodeURIComponent(transaction.txnId)}`
        : undefined,
      data
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.captureBiometricPid = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['BIOMETRIC_ENROLMENT'] });
    const data = await abdmPost('/v3/enrollment/enrol/capturePID', {
      scope: transaction.metadata?.captureScope || transaction.metadata?.scope,
      txnId: transaction.txnId
    });
    return res.json({ success: true, txnId: transaction.txnId, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.enrolByBiometric = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const method = loginMode(req.body.method);
    if (!['face', 'fingerprint', 'iris'].includes(method)) return res.status(400).json({ success: false, error: 'method must be face, fingerprint or iris' });
    if (!isValidAadhaar(req.body.aadhaarNumber)) return res.status(400).json({ success: false, error: 'A valid Aadhaar number is required' });
    transaction = req.body.txnId
      ? await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['BIOMETRIC_ENROLMENT'] })
      : null;
    const consent = transaction?.consent || consentForIdentity(
      req,
      patient,
      'abha-enrollment',
      '1.4'
    );
    const encryptedAadhaar = await encryptForAbdm(cleanDigits(req.body.aadhaarNumber));
    let authData;
    if (method === 'face') {
      if (!transaction) return res.status(400).json({ success: false, error: 'Face QR enrolment requires a valid txnId' });
      const capture = await abdmPost('/v3/enrollment/enrol/capturePID', {
        scope: transaction.metadata?.captureScope || ['abha-enrol', 'face-verify'],
        txnId: transaction.txnId
      });
      if (String(capture.status || '').toUpperCase() !== 'COMPLETE') {
        return res.status(409).json({ success: false, error: 'Face authentication is not complete in the ABHA App', status: capture.status, message: capture.message });
      }
      authData = { authMethods: ['face_auth'], face: { txnId: transaction.txnId, aadhaar: encryptedAadhaar, mobile: cleanDigits(req.body.mobile) } };
    } else {
      const pid = requireOpaquePid(req.body.pid);
      authData = method === 'fingerprint'
        ? { authMethods: ['bio'], bio: { aadhaar: encryptedAadhaar, fingerPrintAuthPid: pid, mobile: cleanDigits(req.body.mobile) } }
        : { authMethods: ['iris'], iris: { aadhaar: encryptedAadhaar, Pid: pid, mobile: cleanDigits(req.body.mobile) } };
    }
    const data = await abdmPost('/v3/enrollment/enrol/byAadhaar', {
      authData,
      consent: {
        code: consent.code || 'abha-enrollment',
        version: consent.version || '1.4'
      }
    });
    const saved = await saveVerifiedProfile({ patient, profile: extractProfile(data), tokens: extractTokens(data), method: `ABDM_${method.toUpperCase()}_ENROLMENT`, userId: req.user._id });
    if (transaction) await markCompleted(transaction);
    return res.json({ success: true, message: data.message, abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.searchAbhaAddressLogin = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const address = String(req.body.abhaAddress || patient.abha?.address || '').trim().toLowerCase();
    if (!address.includes('@')) return res.status(400).json({ success: false, error: 'A valid ABHA address is required' });
    const consent = consentForIdentity(req, patient);
    const data = await abdmPost('/v3/phr/web/login/abha/search', { abhaAddress: address });
    const txnId = data.txnId || data.transactionId;
    const transaction = await createTransaction({ txnId, flow: 'ABHA_ADDRESS_LOGIN', patient, userId: req.user._id, consent, req, metadata: { address, authMethods: data.authMethods } });
    return res.json({ success: true, txnId: transaction.txnId, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestAbhaAddressLoginOtp = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const search = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['ABHA_ADDRESS_LOGIN'] });
    const method = String(req.body.otpSystem || 'abdm').toLowerCase() === 'aadhaar' ? 'aadhaar' : 'abdm';
    const scope = ['abha-address-login', method === 'aadhaar' ? 'aadhaar-verify' : 'mobile-verify'];
    const data = await abdmPost('/v3/phr/web/login/abha/request/otp', {
      scope,
      loginHint: 'abha-address',
      loginId: await encryptForAbdm(search.metadata.address),
      otpSystem: method
    });
    const transaction = await createTransaction({ txnId: data.txnId, flow: 'ABHA_ADDRESS_LOGIN', patient, userId: req.user._id, consent: search.consent, req, metadata: { address: search.metadata.address, scope, searchTxnId: search.txnId } });
    return res.json({ success: true, txnId: transaction.txnId, message: data.message });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyAbhaAddressLoginOtp = async (req, res) => {
  let transaction;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['ABHA_ADDRESS_LOGIN'] });
    const data = await abdmPost('/v3/phr/web/login/abha/verify', {
      scope: transaction.metadata?.scope,
      authData: { authMethods: ['otp'], otp: { txnId: transaction.txnId, otpValue: await encryptForAbdm(req.body.otp) } }
    });
    const saved = await saveVerifiedProfile({ patient, profile: extractProfile(data), tokens: extractTokens(data), method: 'ABDM_ABHA_ADDRESS_OTP', userId: req.user._id });
    await markCompleted(transaction);
    return res.json({ success: true, abha: safeAbha(saved) });
  } catch (error) {
    if (transaction) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
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
    assertAbdmExchangeEligible(patient);
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
    assertAbdmExchangeEligible(patient);
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
    assertAbdmExchangeEligible(patient);
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
