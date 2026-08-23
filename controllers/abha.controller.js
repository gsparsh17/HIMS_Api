const Patient = require('../models/Patient');
const AbdmIdentityTransaction = require('../models/AbdmIdentityTransaction');
const AbdmCareContext = require('../models/AbdmCareContext');
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
const { resolveVerifiedM1Profile } = require('../services/abdmM1ProfileAuth.service');
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
const { assertPatientAccess, accessiblePatientIds, autoPurpose } = require('../services/patientAccessPolicy.service');
const {
  beginOperation, beforeExternal, externalAccepted, externalFailed,
  localCommitted, completeOperation, requireReconciliation, assertSafeIdempotentReplay, sha256: operationSha256
} = require('../services/abdmOperationLedger.service');

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
    token: typeof data.token === 'string' ? data.token : (data.accessToken || data.xToken),
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

async function saveVerifiedProfile({ patient, profile, tokens, method, userId, sessionKind = 'ABHA_PROFILE' }) {
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
  await storePatientSession({ patient: saved, tokens, updatedBy: userId, sessionKind });
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
  let operation;
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
    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_ABHA_CREATION',
      action: 'AADHAAR_REQUEST_OTP',
      requestSummary: { patientId: String(patient._id), aadhaarLast4: cleanAadhaar.slice(-4), consentCode: consent.code, consentVersion: consent.version },
      consentEvidenceHash: operationSha256(`${consent.code}:${consent.version}:${consent.textHash}:${consent.acceptedAt?.toISOString?.() || ''}`)
    });
    assertSafeIdempotentReplay(operation);
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, txnId: operation.externalTxnId, message: 'ABDM OTP request was already completed' });
    }

    const encryptedAadhaar = await encryptForAbdm(cleanAadhaar);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/request/otp', {
        txnId: '',
        scope: ['abha-enrol'],
        loginHint: 'aadhaar',
        loginId: encryptedAadhaar,
        otpSystem: 'aadhaar'
      });
      await externalAccepted(operation, data, { txnId: data.txnId });
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }

    try {
      const transaction = await createTransaction({
        txnId: data.txnId,
        flow: 'AADHAAR_ENROLMENT',
        patient,
        userId: req.user._id,
        consent,
        req,
        metadata: { aadhaarLast4: cleanAadhaar.slice(-4), operationId: operation.operationId }
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
      await localCommitted(operation, { identityTransactionId: String(transaction._id), txnId: transaction.txnId });
      await completeOperation(operation, { patientId: String(patient._id) });
      return res.json({ success: true, operationId: operation.operationId, txnId: transaction.txnId, message: data.message });
    } catch (error) {
      await requireReconciliation(operation, 'ABDM OTP request succeeded externally but local transaction/patient state did not fully commit', error);
      throw error;
    }
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(operation?.operationId ? { operationId: operation.operationId, operationStatus: operation.status } : {}),
      details: error.details
    });
  }
};

exports.enrolByAadhaarOtp = async (req, res) => {
  let transaction;
  let operation;
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

    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_ABHA_CREATION',
      action: 'AADHAAR_ENROL_BY_OTP',
      requestSummary: { patientId: String(patient._id), txnId, mobileLast4: mobile ? cleanDigits(mobile).slice(-4) : undefined },
      consentEvidenceHash: operationSha256(`${transaction.consent?.code || 'abha-enrollment'}:${transaction.consent?.version || '1.4'}:${transaction.consent?.textHash || ''}`)
    });
    assertSafeIdempotentReplay(operation);
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      const current = await Patient.findById(patient._id);
      return res.json({
        success: true,
        idempotent: true,
        operationId: operation.operationId,
        patientId: current._id,
        abha: safeAbha(current),
        credential: await getPatientSessionStatus(current._id, 'ABHA_PROFILE')
      });
    }

    const encryptedOtp = await encryptForAbdm(otp);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/enrol/byAadhaar', {
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
      await externalAccepted(operation, data, { txnId: data.txnId || txnId });
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }

    try {
      const saved = await saveVerifiedProfile({
        patient,
        profile: extractProfile(data),
        tokens: extractTokens(data),
        method: 'ABDM_AADHAAR_OTP',
        userId: req.user._id
      });
      await markCompleted(transaction, { isNew: data.isNew, operationId: operation.operationId });
      await localCommitted(operation, { patientId: String(saved._id), identityTransactionId: String(transaction._id) });
      await completeOperation(operation, { isNew: Boolean(data.isNew) });
      return res.json({
        success: true,
        operationId: operation.operationId,
        message: data.message,
        isNew: data.isNew,
        patientId: saved._id,
        abha: safeAbha(saved),
        credential: await getPatientSessionStatus(saved._id, 'ABHA_PROFILE')
      });
    } catch (error) {
      await requireReconciliation(operation, 'ABHA enrollment succeeded externally but verified profile/local transaction did not fully commit', error);
      throw error;
    }
  } catch (error) {
    const ambiguous = operation && ['EXTERNAL_ACCEPTED', 'LOCAL_COMMITTED', 'RECONCILIATION_REQUIRED', 'UNKNOWN'].includes(operation.status);
    if (transaction && !ambiguous) await recordAttempt(transaction, error).catch(() => { });
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(operation?.operationId ? { operationId: operation.operationId, operationStatus: operation.status } : {}),
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

function hasVerifiedAbdmIdentity(patient) {
  return (
    String(patient?.abha?.status || '').toUpperCase() === 'VERIFIED' &&
    patient?.abha?.kycVerified === true &&
    String(patient?.abha?.identityReconciliation?.status || '').toUpperCase() === 'MATCHED'
  );
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
    const patientUpdate = {
      'abha.registrationMode': 'mobile_search',
      'abha.existingSearchTxnId': transaction.txnId
    };
    // Starting a new authentication challenge must not invalidate a previously
    // verified/reconciled ABHA identity. The transaction carries the pending
    // state until verification succeeds. This prevents an abandoned OTP flow
    // from blocking M2/M3 record exchange for an already verified patient.
    if (!hasVerifiedAbdmIdentity(patient)) {
      patientUpdate['abha.status'] = 'VERIFICATION_PENDING';
    }
    await Patient.updateOne(
      { _id: patient._id },
      { $set: patientUpdate }
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
    const patientUpdate = {
      'abha.existingLoginTxnId': loginTransaction.txnId,
      'abha.existingSelectedIndex': String(index)
    };
    if (!hasVerifiedAbdmIdentity(patient)) {
      patientUpdate['abha.status'] = 'OTP_SENT';
    }
    await Patient.updateOne(
      { _id: patient._id },
      { $set: patientUpdate }
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
    // M1 Find-ABHA authentication returns the final X/R session first; the
    // canonical profile is then fetched from /v3/profile/account using X-token.
    // Do not route this selected-index M1 flow through PHR-style Verify User.
    const { profile, tokens } = await resolveVerifiedM1Profile(data);
    const saved = await saveVerifiedProfile({
      patient,
      profile,
      tokens,
      method: 'ABDM_FACE_QR_LOGIN',
      userId: req.user._id,
      sessionKind: 'ABHA_PROFILE'
    });
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
    // This is the documented M1 Find-ABHA selected-index flow:
    // search -> request OTP -> verify -> final X/R session -> profile/account.
    // It is intentionally separate from the PHR user-selection flow.
    const { profile, tokens } = await resolveVerifiedM1Profile(data);
    const saved = await saveVerifiedProfile({
      patient,
      profile,
      tokens,
      method: 'ABDM_EXISTING_ABHA_OTP',
      userId: req.user._id,
      sessionKind: 'ABHA_PROFILE'
    });
    await markCompleted(transaction);
    return res.json({
      success: true,
      message: data.message,
      abha: safeAbha(saved),
      credential: await getPatientSessionStatus(saved._id, 'ABHA_PROFILE')
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
    { updatedBy: options.updatedBy, sessionKind: 'ABHA_PROFILE' }
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
    await clearPatientSession(patient._id, 'ABHA_PROFILE');
    return res.json({ success: true, message: 'ABHA profile session logged out' });
  } catch (error) {
    if (error.code === 'ABHA_REAUTH_REQUIRED') {
      await clearPatientSession(req.params.patientId, 'ABHA_PROFILE').catch(() => { });
      return res.json({ success: true, message: 'ABHA profile session was already expired' });
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};


exports.retireLocalAssociation = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId, req.user);
    const reason = String(req.body?.reason || '').trim();
    const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
    if (reason.length < 20) {
      return res.status(400).json({ success: false, code: 'RETIRE_REASON_REQUIRED', error: 'A detailed reason of at least 20 characters is required' });
    }
    if (confirmation !== 'RETIRE LOCAL ABHA ASSOCIATION') {
      return res.status(400).json({ success: false, code: 'RETIRE_CONFIRMATION_REQUIRED', error: 'Type RETIRE LOCAL ABHA ASSOCIATION to confirm' });
    }
    if (!patient.abha?.number && !patient.abha?.address) {
      return res.status(409).json({ success: false, code: 'ABHA_NOT_ASSOCIATED', error: 'No local ABHA association exists on this patient record' });
    }

    const linkedCareContexts = await AbdmCareContext.countDocuments({
      hospitalId: patient.hospitalId,
      patientId: patient._id,
      linkStatus: 'ABDM_LINKED',
      active: { $ne: false }
    });

    patient.abha.status = 'LOCAL_ASSOCIATION_RETIRED';
    patient.abha.kycVerified = false;
    patient.abha.associationRetiredAt = new Date();
    patient.abha.associationRetiredBy = req.user._id;
    patient.abha.associationRetirementReason = reason;
    await patient.save();
    await clearPatientSession(patient._id, 'ABHA_PROFILE').catch(() => {});

    req.auditMetadata = {
      ...(req.auditMetadata || {}),
      patientId: String(patient._id),
      action: 'LOCAL_ABHA_ASSOCIATION_RETIRED',
      linkedCareContextsPreserved: linkedCareContexts
    };

    return res.json({
      success: true,
      status: 'LOCAL_ASSOCIATION_RETIRED',
      linkedCareContextsPreserved: linkedCareContexts,
      message: 'The local ABHA association is retired and future ABDM exchange is blocked for this patient until re-verification. Existing ABDM-linked care contexts and audit/consent history are preserved; ABDM does not support unlinking already linked care contexts.'
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, code: error.code, error: error.message });
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
      credential: await getPatientSessionStatus(patient._id, 'ABHA_PROFILE')
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
    const accessibleIds = await accessiblePatientIds(req.user, hospitalId, autoPurpose(req.user));
    if (Array.isArray(accessibleIds)) filter._id = { $in: accessibleIds };
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
    const abhaAddress = String(req.body.abhaAddress || patient.abha?.address || '')
      .trim()
      .toLowerCase();
    if (!abhaAddress.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid abhaAddress is required' });
    }
    consentForIdentity(req, patient, 'abha-address-password-login', '1.0');
    // PHR V3 password search is an ABHA Address lookup. It intentionally does
    // not return a transaction ID; the previous /v3/profile/login/search call
    // was from the wrong API family and caused a false 502.
    const data = await abdmPost('/v3/phr/app/login/search', { abhaAddress });
    const authMethods = Array.isArray(data?.authMethods) ? data.authMethods : [];
    return res.json({
      success: true,
      abhaAddress: data?.abhaAddress || abhaAddress,
      authMethods,
      passwordSupported: authMethods.some((item) => String(item).toUpperCase() === 'PASSWORD'),
      data
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.verifyPasswordLogin = async (req, res) => {
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const abhaAddress = String(req.body.abhaAddress || patient.abha?.address || '')
      .trim()
      .toLowerCase();
    if (!abhaAddress.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid abhaAddress is required' });
    }
    if (!req.body.password) {
      return res.status(400).json({ success: false, error: 'password is required' });
    }
    consentForIdentity(req, patient, 'abha-address-password-login', '1.0');
    const data = await abdmPost('/v3/phr/app/login/verify', {
      scope: ['abha-address-login', 'password-verify'],
      authData: {
        authMethods: ['password'],
        password: {
          abhaAddress,
          password: await encryptForAbdm(req.body.password)
        }
      }
    });
    if (data.authResult && String(data.authResult).toLowerCase() !== 'success') {
      const error = new Error(data.message || 'ABHA Address password verification failed');
      error.statusCode = 400;
      throw error;
    }

    const tokens = extractTokens(data);
    if (!tokens?.token) {
      const error = new Error('ABDM PHR password login did not return an X-token');
      error.statusCode = 502;
      throw error;
    }
    let profile = extractProfile(data);
    if (!(profile?.ABHANumber || profile?.abhaNumber || getAbhaAddress(profile))) {
      profile = extractProfile(
        await abdmGet('/v3/phr/app/login/profile', {
          'X-token': `Bearer ${tokens.token}`
        })
      );
    }
    const saved = await saveVerifiedProfile({
      patient,
      profile,
      tokens,
      method: 'ABDM_PHR_PASSWORD',
      userId: req.user._id,
      sessionKind: 'PHR_APP'
    });
    return res.json({
      success: true,
      abha: safeAbha(saved),
      credential: await getPatientSessionStatus(saved._id, 'PHR_APP')
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestDocumentEnrollmentOtp = async (req, res) => {
  let operation;
  let accepted = false;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    if (!isValidMobile(req.body.mobile)) return res.status(400).json({ success: false, error: 'A valid mobile is required' });
    const consent = consentForIdentity(req, patient, 'abha-enrollment', '1.4');
    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_DOCUMENT_ENROLMENT',
      action: 'DOCUMENT_REQUEST_OTP',
      requestSummary: { mobileLast4: cleanDigits(req.body.mobile).slice(-4), documentType: 'DRIVING_LICENCE' },
      consentEvidenceHash: operationSha256(JSON.stringify(consent || {}))
    });
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, txnId: operation.externalTxnId, message: 'OTP request already completed' });
    }
    assertSafeIdempotentReplay(operation);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/request/otp', {
        scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
        loginHint: 'mobile',
        loginId: await encryptForAbdm(cleanDigits(req.body.mobile)),
        otpSystem: 'abdm'
      });
      await externalAccepted(operation, data, { txnId: data.txnId });
      accepted = true;
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'DOCUMENT_ENROLMENT',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { documentType: 'DRIVING_LICENCE', operationId: operation.operationId }
    });
    await localCommitted(operation, { identityTransactionId: transaction._id, transactionId: transaction.txnId });
    await completeOperation(operation, { transactionId: transaction.txnId });
    return res.json({ success: true, operationId: operation.operationId, txnId: transaction.txnId, message: data.message });
  } catch (error) {
    if (accepted && operation && !['COMPLETED', 'LOCAL_COMMITTED'].includes(operation.status)) {
      await requireReconciliation(operation, 'ABDM document-enrolment OTP succeeded but local transaction commit did not complete', error);
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, operationId: operation?.operationId, error: error.message, details: error.details });
  }
};

exports.verifyDocumentEnrollmentOtp = async (req, res) => {
  let transaction;
  let operation;
  let accepted = false;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['DOCUMENT_ENROLMENT'] });
    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_DOCUMENT_ENROLMENT',
      action: 'DOCUMENT_VERIFY_OTP',
      requestSummary: { transactionId: transaction.txnId, documentType: 'DRIVING_LICENCE' },
      consentEvidenceHash: operationSha256(JSON.stringify(transaction.consent || {}))
    });
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, txnId: operation.externalTxnId || transaction.metadata?.verifiedTxnId || transaction.txnId, message: 'OTP verification was already completed' });
    }
    assertSafeIdempotentReplay(operation);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/auth/byAbdm', {
        scope: ['abha-enrol', 'mobile-verify', 'dl-flow'],
        authData: { authMethods: ['otp'], otp: { timeStamp: new Date().toISOString(), txnId: transaction.txnId, otpValue: await encryptForAbdm(req.body.otp) } }
      });
      await externalAccepted(operation, data, { txnId: data.txnId || transaction.txnId });
      accepted = true;
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }
    transaction.status = 'OTP_VERIFIED';
    transaction.metadata = { ...(transaction.metadata || {}), verifiedTxnId: data.txnId || transaction.txnId, verifyOperationId: operation.operationId };
    await transaction.save();
    await localCommitted(operation, { identityTransactionId: String(transaction._id), verifiedTxnId: data.txnId || transaction.txnId });
    await completeOperation(operation, { transactionStatus: transaction.status });
    return res.json({ success: true, operationId: operation.operationId, txnId: data.txnId || transaction.txnId, message: data.message });
  } catch (error) {
    if (accepted && operation && !['COMPLETED', 'LOCAL_COMMITTED'].includes(operation.status)) {
      await requireReconciliation(operation, 'ABDM document OTP verification succeeded but local transaction state did not fully commit', error);
    } else if (transaction && !operation) {
      await recordAttempt(transaction, error).catch(() => { });
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, operationId: operation?.operationId, operationStatus: operation?.status, error: error.message, details: error.details });
  }
};

exports.enrolByDocument = async (req, res) => {
  let transaction;
  let operation;
  let accepted = false;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    transaction = await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['DOCUMENT_ENROLMENT'] });
    if (transaction.status !== 'OTP_VERIFIED') return res.status(409).json({ success: false, error: 'Mobile OTP must be verified first' });
    const document = req.body.document || {};
    const required = ['documentId', 'firstName', 'lastName', 'dob', 'gender', 'frontSidePhoto', 'backSidePhoto', 'address', 'state', 'district', 'pinCode'];
    const missing = required.filter((field) => !document[field]);
    if (missing.length) return res.status(400).json({ success: false, error: `Missing document fields: ${missing.join(', ')}` });

    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_DOCUMENT_ENROLMENT',
      action: 'DOCUMENT_ENROL',
      requestSummary: { transactionId: transaction.txnId, documentType: 'DRIVING_LICENCE', consentVersion: transaction.consent?.version || '1.4' },
      consentEvidenceHash: operationSha256(JSON.stringify(transaction.consent || {}))
    });
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, abha: safeAbha(patient) });
    }
    assertSafeIdempotentReplay(operation);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/enrol/byDocument', {
        txnId: transaction.metadata?.verifiedTxnId || transaction.txnId,
        documentType: 'DRIVING_LICENCE',
        ...document,
        consent: { code: transaction.consent?.code || 'abha-enrollment', version: transaction.consent?.version || '1.4' }
      });
      await externalAccepted(operation, data, { txnId: data.txnId || transaction.txnId });
      accepted = true;
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }
    const saved = await saveVerifiedProfile({ patient, profile: extractProfile(data), tokens: extractTokens(data), method: 'ABDM_DRIVING_LICENCE', userId: req.user._id });
    await markCompleted(transaction);
    await localCommitted(operation, { patientId: saved._id, identityTransactionId: transaction._id });
    await completeOperation(operation, { abhaStatus: saved.abha?.status });
    return res.json({ success: true, operationId: operation.operationId, message: data.message, abha: safeAbha(saved) });
  } catch (error) {
    if (accepted && operation) {
      await requireReconciliation(operation, 'ABDM document enrolment returned success but local verified-profile commit did not complete', error);
    } else if (transaction) {
      await recordAttempt(transaction, error).catch(() => {});
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, operationId: operation?.operationId, error: error.message, details: error.details });
  }
};

exports.initBiometricEnrollment = async (req, res) => {
  let operation;
  let accepted = false;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const method = loginMode(req.body.method || 'face');
    if (!['face', 'fingerprint', 'iris'].includes(method)) return res.status(400).json({ success: false, error: 'method must be face, fingerprint or iris' });
    const consent = consentForIdentity(req, patient, 'abha-enrollment', '1.4');
    const initScope = ['abha-enrol', method === 'face' ? 'face-auth' : method === 'fingerprint' ? 'bio-verify' : 'iris-verify'];
    const captureScope = ['abha-enrol', method === 'face' ? 'face-verify' : method === 'fingerprint' ? 'bio-verify' : 'iris-verify'];
    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_BIOMETRIC_ENROLMENT',
      action: 'BIOMETRIC_INIT',
      requestSummary: { method, initScope },
      consentEvidenceHash: operationSha256(JSON.stringify(consent || {}))
    });
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, txnId: operation.externalTxnId });
    }
    assertSafeIdempotentReplay(operation);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/enrol/auth/init', { scope: initScope });
      await externalAccepted(operation, data, { txnId: data.txnId });
      accepted = true;
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }
    const transaction = await createTransaction({
      txnId: data.txnId,
      flow: 'BIOMETRIC_ENROLMENT',
      patient,
      userId: req.user._id,
      consent,
      req,
      metadata: { method, initScope, captureScope, operationId: operation.operationId }
    });
    await localCommitted(operation, { identityTransactionId: transaction._id, transactionId: transaction.txnId });
    await completeOperation(operation, { transactionId: transaction.txnId });
    return res.json({
      success: true,
      operationId: operation.operationId,
      txnId: transaction.txnId,
      qrUrl: method === 'face'
        ? `${String(process.env.ABDM_PHR_FACE_AUTH_URL || 'https://phrsbx.abdm.gov.in/face-auth').replace(/\/$/, '')}?txnId=${encodeURIComponent(transaction.txnId)}`
        : undefined,
      data
    });
  } catch (error) {
    if (accepted && operation && !['COMPLETED', 'LOCAL_COMMITTED'].includes(operation.status)) {
      await requireReconciliation(operation, 'ABDM biometric init succeeded but local transaction commit did not complete', error);
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, operationId: operation?.operationId, error: error.message, details: error.details });
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
  let operation;
  let accepted = false;
  try {
    const patient = await ensurePatient(req.body.patientId, req.user);
    const method = loginMode(req.body.method);
    if (!['face', 'fingerprint', 'iris'].includes(method)) return res.status(400).json({ success: false, error: 'method must be face, fingerprint or iris' });
    if (!isValidAadhaar(req.body.aadhaarNumber)) return res.status(400).json({ success: false, error: 'A valid Aadhaar number is required' });
    transaction = req.body.txnId
      ? await getOwnedTransaction({ txnId: req.body.txnId, patient, userId: req.user._id, flows: ['BIOMETRIC_ENROLMENT'] })
      : null;
    const consent = transaction?.consent || consentForIdentity(req, patient, 'abha-enrollment', '1.4');
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

    operation = await beginOperation({
      req,
      patient,
      flow: 'M1_BIOMETRIC_ENROLMENT',
      action: `BIOMETRIC_ENROL_${method.toUpperCase()}`,
      requestSummary: { transactionId: transaction?.txnId, method, aadhaarLast4: cleanDigits(req.body.aadhaarNumber).slice(-4) },
      consentEvidenceHash: operationSha256(JSON.stringify(consent || {}))
    });
    if (operation.$idempotent && operation.status === 'COMPLETED') {
      return res.json({ success: true, idempotent: true, operationId: operation.operationId, abha: safeAbha(patient) });
    }
    assertSafeIdempotentReplay(operation);
    await beforeExternal(operation);
    let data;
    try {
      data = await abdmPost('/v3/enrollment/enrol/byAadhaar', {
        authData,
        consent: { code: consent.code || 'abha-enrollment', version: consent.version || '1.4' }
      });
      await externalAccepted(operation, data, { txnId: data.txnId || transaction?.txnId });
      accepted = true;
    } catch (error) {
      await externalFailed(operation, error);
      throw error;
    }
    const saved = await saveVerifiedProfile({ patient, profile: extractProfile(data), tokens: extractTokens(data), method: `ABDM_${method.toUpperCase()}_ENROLMENT`, userId: req.user._id });
    if (transaction) await markCompleted(transaction);
    await localCommitted(operation, { patientId: saved._id, identityTransactionId: transaction?._id });
    await completeOperation(operation, { abhaStatus: saved.abha?.status });
    return res.json({ success: true, operationId: operation.operationId, message: data.message, abha: safeAbha(saved) });
  } catch (error) {
    if (accepted && operation) {
      await requireReconciliation(operation, 'ABDM biometric enrolment returned success but local verified-profile commit did not complete', error);
    } else if (transaction) {
      await recordAttempt(transaction, error).catch(() => {});
    }
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, operationId: operation?.operationId, error: error.message, details: error.details });
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
    const saved = await saveVerifiedProfile({
      patient,
      profile: extractProfile(data),
      tokens: extractTokens(data),
      method: 'ABDM_ABHA_ADDRESS_OTP',
      userId: req.user._id,
      sessionKind: 'PHR_APP'
    });
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
    const patient = await ensurePatient(bundle.patientId, req.user);
    await assertPatientAccess({ user: req.user, patientId: patient._id, hospitalId: patient.hospitalId, purpose: 'TREATMENT', scope: 'clinical_read' });
    return res.json({ success: true, ehrBundle: bundle });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message
    });
  }
};
