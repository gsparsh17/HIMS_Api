const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const RadiologyRequest = require('../models/RadiologyRequest');
const DischargeSummary = require('../models/DischargeSummary');
const EHRBundle = require('../models/EHRBundle');
const { encryptForAbdm, abdmPost, abdmGet } = require('../services/abdm.service');
const { generateEhrBundle } = require('../services/ehr.service');

function getPatientName(patient) {
  return [patient.salutation, patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ');
}

function getAbhaAddress(profile = {}) {
  if (Array.isArray(profile.phrAddress) && profile.phrAddress.length) return profile.phrAddress[0];
  if (Array.isArray(profile.abhaAddress) && profile.abhaAddress.length) return profile.abhaAddress[0];
  return profile.preferredAbhaAddress || profile.ABHAAddress || profile.abhaAddress || undefined;
}

function sanitizeAbdmTokens(tokens = {}) {
  if (!tokens) return {};
  const expiresIn = Number(tokens.expiresIn || 1800);
  return {
    xToken: tokens.token,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + Math.max(expiresIn - 60, 60) * 1000),
    refreshExpiresAt: tokens.refreshExpiresIn ? new Date(Date.now() + Number(tokens.refreshExpiresIn) * 1000) : undefined
  };
}

function isValidAadhaar(value) {
  return /^\d{12}$/.test(String(value || '').replace(/\D/g, ''));
}

function isValidMobile(value) {
  return /^[6-9]\d{9}$/.test(String(value || '').replace(/\D/g, ''));
}

async function ensurePatient(patientId) {
  const patient = await Patient.findById(patientId);
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }
  return patient;
}

exports.requestAadhaarOtp = async (req, res) => {
  try {
    const { patientId, aadhaarNumber } = req.body;
    const cleanAadhaar = String(aadhaarNumber || '').replace(/\D/g, '');
    if (!patientId || !isValidAadhaar(cleanAadhaar)) {
      return res.status(400).json({ success: false, error: 'patientId and valid 12 digit Aadhaar are required' });
    }

    await ensurePatient(patientId);
    const encryptedAadhaar = await encryptForAbdm(cleanAadhaar);
    const data = await abdmPost('/v3/enrollment/request/otp', {
      txnId: '',
      scope: ['abha-enrol'],
      loginHint: 'aadhaar',
      loginId: encryptedAadhaar,
      otpSystem: 'aadhaar'
    });

    await Patient.findByIdAndUpdate(patientId, {
      aadhaar_last4: cleanAadhaar.slice(-4),
      'abha.status': 'OTP_SENT',
      'abha.registrationMode': 'aadhaar_otp',
      'abha.lastOtpTxnId': data.txnId,
      'abha.lastOtpSentAt': new Date()
    });

    res.json({ success: true, txnId: data.txnId, message: data.message });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.enrolByAadhaarOtp = async (req, res) => {
  try {
    const { patientId, txnId, otp, mobile } = req.body;
    if (!patientId || !txnId || !otp) {
      return res.status(400).json({ success: false, error: 'patientId, txnId and OTP are required' });
    }
    if (mobile && !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'mobile must be a valid 10 digit Indian mobile number' });
    }

    const encryptedOtp = await encryptForAbdm(otp);
    const data = await abdmPost('/v3/enrollment/enrol/byAadhaar', {
      authData: {
        authMethods: ['otp'],
        otp: {
          txnId,
          otpValue: encryptedOtp,
          mobile: mobile || ''
        }
      },
      consent: {
        code: 'abha-enrollment',
        version: '1.4'
      }
    });

    const profile = data.ABHAProfile || data.abhaProfile || {};
    const tokenSession = sanitizeAbdmTokens(data.tokens || {});
    const patient = await Patient.findByIdAndUpdate(
      patientId,
      {
        abha: {
          number: profile.ABHANumber || profile.abhaNumber,
          address: getAbhaAddress(profile),
          status: 'VERIFIED',
          type: profile.abhaType,
          kycVerified: true,
          registrationMode: 'aadhaar_otp',
          verificationMethod: 'ABDM_AADHAAR_OTP',
          verifiedAt: new Date(),
          linkedAt: new Date(),
          lastLinkedBy: req.user?._id,
          profile: {
            firstName: profile.firstName,
            middleName: profile.middleName,
            lastName: profile.lastName,
            dob: profile.dob,
            gender: profile.gender,
            mobileMasked: profile.mobile,
            districtName: profile.districtName,
            stateName: profile.stateName,
            pinCode: profile.pinCode
          },
          session: tokenSession,
          recordLinks: []
        }
      },
      { new: true }
    );

    res.json({
      success: true,
      message: data.message,
      isNew: data.isNew,
      patientId: patient._id,
      abha: patient.abha,
      xTokenAvailable: Boolean(tokenSession.xToken),
      xTokenExpiresAt: tokenSession.expiresAt
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.captureExistingAbha = async (req, res) => {
  try {
    const { patientId, abhaNumber, abhaAddress } = req.body;
    if (!patientId || (!abhaNumber && !abhaAddress)) {
      return res.status(400).json({ success: false, error: 'patientId and at least one of abhaNumber or abhaAddress are required' });
    }

    // Manual capture is intentionally not considered verified. Use the mobile search/login
    // flow below to move the patient to VERIFIED state.
    const patient = await Patient.findByIdAndUpdate(
      patientId,
      {
        'abha.number': abhaNumber || undefined,
        'abha.address': abhaAddress ? String(abhaAddress).toLowerCase() : undefined,
        'abha.status': 'VERIFICATION_PENDING',
        'abha.registrationMode': 'manual_capture',
        'abha.kycVerified': false,
        'abha.verificationMethod': 'MANUAL_UNVERIFIED',
        'abha.lastLinkedBy': req.user?._id
      },
      { new: true }
    );
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    res.json({
      success: true,
      message: 'ABHA details saved as unverified. Complete ABDM verification before using them for care-context linking.',
      abha: patient.abha
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

function normalizeSearchResponse(data) {
  const first = Array.isArray(data) ? data[0] : data;
  return {
    txnId: first?.txnId,
    accounts: first?.ABHA || first?.accounts || []
  };
}

exports.searchExistingAbhaByMobile = async (req, res) => {
  try {
    const { patientId, mobile } = req.body;
    if (!patientId || !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'patientId and a valid 10 digit mobile number are required' });
    }
    await ensurePatient(patientId);
    const encryptedMobile = await encryptForAbdm(String(mobile).replace(/\D/g, ''));
    const data = await abdmPost('/v3/profile/account/abha/search', {
      scope: ['search-abha'],
      mobile: encryptedMobile
    });
    const normalized = normalizeSearchResponse(data);
    if (!normalized.txnId) {
      return res.status(502).json({ success: false, error: 'ABDM search response did not contain a transaction ID', details: data });
    }
    await Patient.findByIdAndUpdate(patientId, {
      'abha.status': 'VERIFICATION_PENDING',
      'abha.registrationMode': 'mobile_search',
      'abha.existingSearchTxnId': normalized.txnId
    });
    res.json({ success: true, txnId: normalized.txnId, accounts: normalized.accounts });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.requestExistingAbhaOtp = async (req, res) => {
  try {
    const { patientId, txnId, index } = req.body;
    if (!patientId || !txnId || index === undefined || index === null || index === '') {
      return res.status(400).json({ success: false, error: 'patientId, txnId and selected ABHA index are required' });
    }
    await ensurePatient(patientId);
    const encryptedIndex = await encryptForAbdm(String(index));
    const data = await abdmPost('/v3/profile/login/request/otp', {
      scope: ['abha-login', 'search-abha', 'mobile-verify'],
      loginHint: 'index',
      loginId: encryptedIndex,
      otpSystem: 'abdm',
      txnId
    });
    await Patient.findByIdAndUpdate(patientId, {
      'abha.existingLoginTxnId': data.txnId,
      'abha.existingSelectedIndex': String(index),
      'abha.status': 'OTP_SENT'
    });
    res.json({ success: true, txnId: data.txnId, message: data.message });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.verifyExistingAbhaOtp = async (req, res) => {
  try {
    const { patientId, txnId, otp } = req.body;
    if (!patientId || !txnId || !otp) {
      return res.status(400).json({ success: false, error: 'patientId, txnId and OTP are required' });
    }
    await ensurePatient(patientId);
    const encryptedOtp = await encryptForAbdm(otp);
    const data = await abdmPost('/v3/profile/login/verify', {
      scope: ['abha-login', 'mobile-verify'],
      authData: {
        authMethods: ['otp'],
        otp: { txnId, otpValue: encryptedOtp }
      }
    });
    if (String(data.authResult || '').toLowerCase() !== 'success') {
      return res.status(400).json({ success: false, error: data.message || 'ABHA verification failed', details: data });
    }

    const account = Array.isArray(data.accounts) ? data.accounts[0] : data.account || {};
    const tokenSession = sanitizeAbdmTokens(data);
    const patient = await Patient.findByIdAndUpdate(
      patientId,
      {
        'abha.number': account.ABHANumber || account.abhaNumber,
        'abha.address': account.preferredAbhaAddress || getAbhaAddress(account),
        'abha.status': 'VERIFIED',
        'abha.type': account.abhaType,
        'abha.kycVerified': account.kycVerified !== false,
        'abha.registrationMode': 'mobile_search',
        'abha.verificationMethod': 'ABDM_MOBILE_OTP',
        'abha.verifiedAt': new Date(),
        'abha.linkedAt': new Date(),
        'abha.lastLinkedBy': req.user?._id,
        'abha.session': tokenSession,
        'abha.profile.firstName': account.firstName,
        'abha.profile.middleName': account.middleName,
        'abha.profile.lastName': account.lastName,
        'abha.profile.gender': account.gender,
        'abha.profile.dob': account.dob
      },
      { new: true }
    );
    res.json({
      success: true,
      message: data.message || 'ABHA verified successfully',
      abha: patient.abha,
      xTokenAvailable: Boolean(tokenSession.xToken),
      xTokenExpiresAt: tokenSession.expiresAt
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.requestMobileOtp = async (req, res) => {
  try {
    const { patientId, mobile, txnId } = req.body;
    if (!patientId || !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, error: 'patientId and valid mobile are required' });
    }
    const patient = await ensurePatient(patientId);
    const encryptedMobile = await encryptForAbdm(String(mobile).replace(/\D/g, ''));
    const data = await abdmPost('/v3/enrollment/request/otp', {
      txnId: txnId || patient.abha?.lastOtpTxnId || '',
      scope: ['abha-enrol', 'mobile-verify'],
      loginHint: 'mobile',
      loginId: encryptedMobile,
      otpSystem: 'abdm'
    });
    await Patient.findByIdAndUpdate(patientId, {
      'abha.mobileVerificationTxnId': data.txnId,
      'abha.mobileVerificationStatus': 'otp_sent'
    });
    res.json({ success: true, txnId: data.txnId, message: data.message });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.verifyMobileOtp = async (req, res) => {
  try {
    const { patientId, txnId, otp } = req.body;
    if (!patientId || !txnId || !otp) return res.status(400).json({ success: false, error: 'patientId, txnId and OTP are required' });
    const encryptedOtp = await encryptForAbdm(otp);
    const data = await abdmPost('/v3/enrollment/auth/byAbdm', {
      scope: ['abha-enrol', 'mobile-verify'],
      authData: {
        authMethods: ['otp'],
        otp: { timeStamp: new Date().toISOString(), txnId, otpValue: encryptedOtp }
      }
    });
    const patient = await Patient.findByIdAndUpdate(patientId, {
      'abha.mobileVerificationStatus': 'verified',
      'abha.mobileVerifiedAt': new Date()
    }, { new: true });
    res.json({ success: true, message: data.message || 'Mobile verified', abha: patient?.abha });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

function getRecentXToken(patient, req) {
  const explicitToken = req.headers['x-token'] || req.body?.xToken || req.query?.xToken;
  if (explicitToken) return String(explicitToken).startsWith('Bearer ') ? String(explicitToken) : `Bearer ${explicitToken}`;
  const token = patient?.abha?.session?.xToken;
  const expiresAt = patient?.abha?.session?.expiresAt;
  if (!token || !expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
    const error = new Error('ABHA user X-token missing or expired. Login/link ABHA again before downloading QR/card.');
    error.statusCode = 400;
    throw error;
  }
  return `Bearer ${token}`;
}

exports.getQrCode = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId);
    const xToken = getRecentXToken(patient, req);
    const response = await abdmGet('/v3/profile/account/qrCode', { 'X-token': xToken }, 'buffer');
    res.setHeader('Content-Type', response.contentType);
    res.send(response.buffer);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.getAbhaCard = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId);
    const xToken = getRecentXToken(patient, req);
    const response = await abdmGet('/v3/profile/account/abha-card', { 'X-token': xToken }, 'buffer');
    res.setHeader('Content-Type', response.contentType);
    res.setHeader('Content-Disposition', `inline; filename="abha-card-${patient.patientId || patient._id}.pdf"`);
    res.send(response.buffer);
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message, details: err.details });
  }
};

exports.searchPatientsByAbha = async (req, res) => {
  try {
    const { query, status, limit = 20 } = req.query;
    const conditions = [];
    if (query) {
      const regex = new RegExp(String(query).trim(), 'i');
      conditions.push({ 'abha.number': regex }, { 'abha.address': regex }, { first_name: regex }, { last_name: regex }, { phone: regex }, { patientId: regex }, { uhid: regex });
    }
    const filter = conditions.length ? { $or: conditions } : {};
    if (status) filter['abha.status'] = status;
    const patients = await Patient.find(filter)
      .select('patientId uhid first_name middle_name last_name phone gender dob patient_type abha registered_at')
      .sort({ registered_at: -1 })
      .limit(Math.min(Number(limit) || 20, 100))
      .lean();
    res.json({ success: true, count: patients.length, patients: patients.map(p => ({ ...p, name: getPatientName(p) })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

async function linkOneRecord({ patient, recordType, recordId, ehrBundleId, source = 'manual' }) {
  const def = RECORD_MODELS[recordType];
  if (!def) throw new Error(`Unsupported recordType: ${recordType}`);
  const record = await def.model.findById(recordId);
  if (!record) throw new Error(`${recordType} not found`);
  if (String(record[def.patientField]) !== String(patient._id)) throw new Error(`${recordType} does not belong to this patient`);
  record.abdmRecordLink = {
    patientId: patient._id,
    abhaNumber: patient.abha?.number,
    abhaAddress: patient.abha?.address,
    status: patient.abha?.status === 'VERIFIED' ? 'LOCAL_RECORD_READY' : 'VERIFICATION_PENDING',
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
    if (!patientId || !recordType || !recordId) return res.status(400).json({ success: false, error: 'patientId, recordType and recordId are required' });
    const patient = await ensurePatient(patientId);
    const record = await linkOneRecord({ patient, recordType, recordId, ehrBundleId, source: 'manual' });
    await Patient.updateOne({ _id: patient._id }, { $addToSet: { 'abha.recordLinks': { recordType, recordId, ehrBundleId, linkedAt: new Date(), status: record.abdmRecordLink.status } } });
    res.json({ success: true, recordType, recordId, link: record.abdmRecordLink });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

exports.linkAllPatientRecords = async (req, res) => {
  try {
    const patient = await ensurePatient(req.params.patientId);
    const results = [];
    for (const [recordType, def] of Object.entries(RECORD_MODELS)) {
      const records = await def.model.find({ [def.patientField]: patient._id }).select('_id');
      for (const record of records) {
        try {
          await linkOneRecord({ patient, recordType, recordId: record._id, source: 'bulk_patient_link' });
          results.push({ recordType, recordId: record._id, status: 'LOCAL_RECORD_READY' });
        } catch (error) {
          results.push({ recordType, recordId: record._id, status: 'failed', error: error.message });
        }
      }
    }
    await Patient.updateOne({ _id: patient._id }, { 'abha.lastRecordLinkSyncAt': new Date() });
    res.json({ success: true, count: results.length, results });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

exports.generateEhr = async (req, res) => {
  try {
    const { patientId, bundleType = 'EMR_SUMMARY' } = req.body;
    if (!patientId) return res.status(400).json({ success: false, error: 'patientId is required' });
    const { ehrBundle, bundle } = await generateEhrBundle(patientId, { bundleType, createdBy: req.user?._id });
    await Patient.updateOne({ _id: patientId }, { 'abha.lastEhrBundleId': ehrBundle._id, 'abha.lastEhrGeneratedAt': new Date() });
    res.json({ success: true, ehrBundleId: ehrBundle._id, recordCounts: ehrBundle.recordCounts, bundle });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
};

exports.getPatientEhrBundles = async (req, res) => {
  try {
    const bundles = await EHRBundle.find({ patientId: req.params.patientId })
      .select('-bundle.entry.resource.content')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ success: true, bundles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getEhrBundle = async (req, res) => {
  try {
    const bundle = await EHRBundle.findById(req.params.bundleId).lean();
    if (!bundle) return res.status(404).json({ success: false, error: 'EHR bundle not found' });
    res.json({ success: true, ehrBundle: bundle });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.requestPhrConsentStub = async (req, res) => {
  res.status(501).json({
    success: false,
    error: 'PHR consent/HIU-HIP exchange is not enabled in this starter pack.',
    nextSteps: [
      'Register facility as HIP/HIU as applicable.',
      'Implement ABDM Gateway consent request callbacks.',
      'Map generated FHIR bundles to ABDM health information transfer APIs.',
      'Use ABHA Address, purpose of use, date range, and consent artefact before sharing records.'
    ],
    receivedPayload: req.body
  });
};
