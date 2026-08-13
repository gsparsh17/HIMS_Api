const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Hospital = require('../models/Hospital');
const Patient = require('../models/Patient');
const PatientPortalOtp = require('../models/PatientPortalOtp');
const PatientPortalAbdmTransaction = require('../models/PatientPortalAbdmTransaction');
const { sendPortalOtp } = require('../services/patientPortalSms.service');
const { encryptForAbdm, encryptForPhr, abdmPost, abdmGet } = require('../services/abdm.service');
const { storePatientSession } = require('../services/abdmCredential.service');
const { encryptJson, decryptJson } = require('../services/abdmVault.service');

const cleanDigits = (v) => String(v || '').replace(/\D/g, '');
const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex');
const portalTtl = () => Math.max(15, Number(process.env.PATIENT_PORTAL_SESSION_MINUTES || 720));

async function hospitalForPublicRequest(req) {
  const explicit = req.body?.hospitalId || req.query?.hospitalId;
  if (explicit) {
    const hospital = await Hospital.findById(explicit);
    if (hospital) return hospital;
  }
  const hospital = await Hospital.findOne({}).sort({ createdAt: 1 });
  if (!hospital) { const e = new Error('Hospital is not configured'); e.statusCode = 503; throw e; }
  return hospital;
}

function patientLabel(patient) {
  return {
    patientId: patient._id,
    uhid: patient.uhid || patient.patientId,
    name: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' '),
    dob: patient.dob,
    gender: patient.gender,
    maskedMobile: patient.phone ? `${String(patient.phone).slice(0,2)}******${String(patient.phone).slice(-2)}` : '',
    abha: patient.abha ? { number: patient.abha.number, address: patient.abha.address, status: patient.abha.status } : undefined
  };
}

function issuePatientToken(patient) {
  return jwt.sign({ patientPortal: true, patientId: String(patient._id), hospitalId: String(patient.hospitalId), role: 'patient' }, process.env.JWT_SECRET, { expiresIn: `${portalTtl()}m` });
}


function profileFromResponse(data = {}) {
  return data.ABHAProfile || data.profile || data.abhaProfile || data;
}
function tokenSetFromResponse(data = {}) {
  return data.tokens || {
    token: data.token || data.accessToken || data.xToken,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
    refreshExpiresIn: data.refreshExpiresIn,
    switchProfileEnabled: data.switchProfileEnabled
  };
}

function debugEnabled() {
  return String(process.env.PATIENT_PORTAL_ABDM_DEBUG || '').trim().toLowerCase() === 'true';
}

function tokenFingerprint(value) {
  const token = String(value || '').trim();
  return token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) : null;
}

function normalizeAbhaNumber(value) {
  const digits = cleanDigits(value);
  if (digits.length !== 14) return '';
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10, 14)}`;
}

function phrUserLabel(user = {}) {
  const abhaAddress = String(
    user.abhaAddress || user.preferredAbhaAddress || user.preferredAddress || ''
  ).trim().toLowerCase();
  return {
    abhaAddress,
    fullName: user.fullName || user.name || [user.firstName, user.middleName, user.lastName].filter(Boolean).join(' '),
    abhaNumber: user.abhaNumber || user.ABHANumber || '',
    status: user.status || '',
    kycStatus: user.kycStatus || user.verificationStatus || ''
  };
}

function phrUsersFromResponse(data = {}) {
  const candidates = [];
  if (Array.isArray(data.users)) candidates.push(...data.users);
  if (Array.isArray(data.accounts)) candidates.push(...data.accounts);
  if (data.preferredAbhaAddress) candidates.push({
    abhaAddress: data.preferredAbhaAddress,
    abhaNumber: data.abhaNumber || data.ABHANumber
  });

  const seen = new Set();
  return candidates
    .map(phrUserLabel)
    .filter((user) => {
      if (!user.abhaAddress || seen.has(user.abhaAddress)) return false;
      seen.add(user.abhaAddress);
      return true;
    });
}

function isFinalPhrTokenSet(tokens = {}) {
  const expiresIn = Number(tokens.expiresIn || 0);
  return Boolean(tokens.token) && (Boolean(tokens.refreshToken) || expiresIn > 600);
}

function bearer(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}
async function patientFromVerifiedProfile(hospitalId, profile = {}) {
  const abhaNumber = profile.ABHANumber || profile.abhaNumber || profile.healthIdNumber;
  const abhaAddress = profile.preferredAddress || profile.abhaAddress || profile.healthId || profile.phrAddress?.[0];
  const clauses = [];
  if (abhaNumber) clauses.push({ 'abha.number': String(abhaNumber) });
  if (abhaAddress) clauses.push({ 'abha.address': String(abhaAddress).toLowerCase() });
  if (!clauses.length) return { patient: null, abhaNumber, abhaAddress };
  const patient = await Patient.findOne({ hospitalId, $or: clauses });
  return { patient, abhaNumber, abhaAddress };
}
async function finishVerifiedPortalLogin(record, data) {
  const profile = profileFromResponse(data);
  const { patient, abhaNumber, abhaAddress } = await patientFromVerifiedProfile(record.hospitalId, profile);
  if (!patient) {
    const error = new Error('ABDM authentication succeeded, but this ABHA is not linked to a patient record in this hospital');
    error.statusCode = 404;
    error.details = { abhaNumber, abhaAddress };
    throw error;
  }

  // This helper is used by ABHA Profile / Face Auth identity flows. Their
  // token is not a PHR application login token, so do not persist it as the
  // patient HIE-CM session. PHR logins use finishPhrPortalLogin below.
  record.status = 'VERIFIED';
  record.selectedAbhaNumber = abhaNumber;
  record.abhaAddress = abhaAddress;
  await record.save();
  return { success: true, token: issuePatientToken(patient), patient: patientLabel(patient), abha: { number: abhaNumber, address: abhaAddress } };
}

async function fetchPhrProfile(xToken) {
  return abdmGet('/v3/phr/app/login/profile', {
    'X-token': bearer(xToken)
  });
}

async function finishPhrPortalLogin(record, tokenResponse, profile) {
  const tokens = tokenSetFromResponse(tokenResponse);
  if (!tokens.token) {
    const error = new Error('ABDM PHR login did not return an X-token');
    error.statusCode = 502;
    throw error;
  }

  const { patient, abhaNumber, abhaAddress } = await patientFromVerifiedProfile(record.hospitalId, profile);
  if (!patient) {
    const error = new Error('ABDM PHR authentication succeeded, but this ABHA is not linked to a patient record in this hospital');
    error.statusCode = 404;
    error.details = { abhaNumber, abhaAddress };
    throw error;
  }

  await storePatientSession({ patient, tokens, sessionKind: 'PHR_APP' });
  record.status = 'VERIFIED';
  record.selectedAbhaNumber = abhaNumber;
  record.abhaAddress = abhaAddress;
  record.metadata = {
    ...(record.metadata || {}),
    intermediateToken: undefined,
    candidateAbhaAddresses: undefined,
    phrLoginCompletedAt: new Date().toISOString()
  };
  await record.save();

  return {
    success: true,
    token: issuePatientToken(patient),
    patient: patientLabel(patient),
    abha: { number: abhaNumber, address: abhaAddress }
  };
}

async function verifyPhrUserSelection(record, abhaAddress, tToken) {
  const token = String(tToken || '').trim().replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('ABDM PHR T-token is missing');

  const headerCandidates = [`Bearer ${token}`, token];
  let lastError;
  for (let index = 0; index < headerCandidates.length; index += 1) {
    try {
      return await abdmPost(
        '/v3/phr/app/login/verify/user',
        { abhaAddress, txnId: record.txnId },
        { 'T-token': headerCandidates[index] }
      );
    } catch (error) {
      lastError = error;
      const upstreamMessage = [
        error?.message,
        error?.details?.message,
        error?.details?.error,
        Array.isArray(error?.details) ? error.details.map((item) => item?.message).join(' ') : ''
      ].filter(Boolean).join(' ');
      const invalidTToken = /invalid\s+t-?token/i.test(upstreamMessage);
      if (!invalidTToken || index === headerCandidates.length - 1) throw error;
    }
  }
  throw lastError || new Error('ABDM PHR Verify User failed');
}

exports.requestMobileOtp = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const mobile = cleanDigits(req.body.mobile).slice(-10);
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ success: false, error: 'A valid 10-digit mobile number is required' });
    const candidates = await Patient.find({ hospitalId: hospital._id, $or: [{ normalizedPhone: mobile }, { phone: { $regex: `${mobile}$` } }] }).select('_id');
    // Deliberately return the same response even if there is no patient to prevent enumeration.
    const otp = String(crypto.randomInt(100000, 1000000));
    await PatientPortalOtp.deleteMany({ hospitalId: hospital._id, mobile, verifiedAt: null });
    const record = await PatientPortalOtp.create({
      hospitalId: hospital._id, mobile, otpHash: hash(otp), expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      requestContext: { ipHash: hash(req.ip), userAgentHash: hash(req.headers['user-agent']) }
    });
    if (candidates.length) await sendPortalOtp({ mobile, otp });
    return res.json({ success: true, requestId: record._id, message: 'If this mobile is registered, an OTP has been sent.', expiresIn: 300 });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.verifyMobileOtp = async (req, res) => {
  try {
    const record = await PatientPortalOtp.findById(req.body.requestId).select('+otpHash');
    if (!record || record.expiresAt <= new Date() || record.verifiedAt) return res.status(400).json({ success: false, error: 'OTP request is invalid or expired' });
    record.attempts += 1;
    if (record.attempts > record.maxAttempts || hash(cleanDigits(req.body.otp)) !== record.otpHash) {
      await record.save();
      return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }
    record.verifiedAt = new Date(); await record.save();
    const patients = await Patient.find({ hospitalId: record.hospitalId, $or: [{ normalizedPhone: record.mobile }, { phone: { $regex: `${record.mobile}$` } }] });
    if (!patients.length) return res.status(404).json({ success: false, error: 'No patient profile is linked to this verified mobile number' });
    if (patients.length === 1) {
      const patient = patients[0];
      return res.json({ success: true, token: issuePatientToken(patient), patient: patientLabel(patient) });
    }
    const selectionToken = jwt.sign({ patientSelection: true, hospitalId: String(record.hospitalId), mobile: record.mobile, candidateIds: patients.map(p => String(p._id)) }, process.env.JWT_SECRET, { expiresIn: '5m' });
    return res.json({ success: true, selectionRequired: true, selectionToken, patients: patients.map(patientLabel) });
  } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
};

exports.selectPatient = async (req, res) => {
  try {
    const claims = jwt.verify(req.body.selectionToken, process.env.JWT_SECRET);
    if (!claims.patientSelection || !claims.candidateIds?.includes(String(req.body.patientId))) return res.status(403).json({ success: false, error: 'Invalid patient selection' });
    const patient = await Patient.findOne({ _id: req.body.patientId, hospitalId: claims.hospitalId });
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    return res.json({ success: true, token: issuePatientToken(patient), patient: patientLabel(patient) });
  } catch (error) { return res.status(401).json({ success: false, error: 'Patient selection expired or invalid' }); }
};


exports.abhaNumberRequestOtp = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const abhaNumber = normalizeAbhaNumber(req.body.abhaNumber);
    if (!abhaNumber) {
      return res.status(400).json({ success: false, error: 'A valid 14-digit ABHA Number is required' });
    }

    const verificationMethod = String(req.body.verificationMethod || 'aadhaar').trim().toLowerCase();
    const config = verificationMethod === 'mobile'
      ? { scope: ['abha-login', 'mobile-verify'], otpSystem: 'abdm' }
      : verificationMethod === 'aadhaar'
        ? { scope: ['abha-login', 'aadhaar-verify'], otpSystem: 'aadhaar' }
        : null;
    if (!config) {
      return res.status(400).json({ success: false, error: 'verificationMethod must be aadhaar or mobile' });
    }

    const data = await abdmPost('/v3/phr/app/login/request/otp', {
      scope: config.scope,
      loginHint: 'abha-number',
      loginId: await encryptForPhr(abhaNumber),
      otpSystem: config.otpSystem
    });

    if (!data?.txnId) {
      const error = new Error('ABDM PHR did not return a transaction ID');
      error.statusCode = 502;
      throw error;
    }

    const record = await PatientPortalAbdmTransaction.create({
      hospitalId: hospital._id,
      flow: 'ABHA_NUMBER_LOGIN',
      txnId: data.txnId,
      status: 'WAITING',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      metadata: {
        apiFamily: 'PHR_APP',
        loginType: 'ABHA_NUMBER',
        scope: config.scope,
        otpSystem: config.otpSystem,
        verificationMethod
      }
    });

    if (debugEnabled()) {
      console.log('PHR_ABHA_NUMBER_REQUEST_OTP', {
        txnId: record.txnId,
        verificationMethod,
        scope: config.scope,
        otpSystem: config.otpSystem
      });
    }

    return res.json({
      success: true,
      txnId: record.txnId,
      message: data.message,
      verificationMethod,
      expiresIn: 600
    });
  } catch (error) {
    if (debugEnabled()) {
      console.error('PHR_ABHA_NUMBER_REQUEST_OTP_ERROR', {
        errorMessage: error.message,
        statusCode: error.statusCode,
        details: error.details
      });
    }
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.abhaNumberVerifyOtp = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({
      txnId: req.body.txnId,
      flow: 'ABHA_NUMBER_LOGIN'
    });
    if (!record || record.expiresAt <= new Date()) {
      return res.status(410).json({ success: false, error: 'ABHA Number login transaction expired' });
    }

    const otp = cleanDigits(req.body.otp);
    if (!otp) return res.status(400).json({ success: false, error: 'OTP is required' });

    const data = await abdmPost('/v3/phr/app/login/verify', {
      scope: record.metadata?.scope,
      authData: {
        authMethods: ['otp'],
        otp: {
          txnId: record.txnId,
          otpValue: await encryptForPhr(otp)
        }
      }
    });

    if (String(data?.authResult || '').toLowerCase() !== 'success') {
      const error = new Error(data?.message || 'ABHA Number OTP verification failed');
      error.statusCode = 400;
      error.details = data;
      throw error;
    }

    const tokens = tokenSetFromResponse(data);
    const users = phrUsersFromResponse(data);

    if (debugEnabled()) {
      console.log('PHR_ABHA_NUMBER_VERIFY', {
        txnIdMatches: !data?.txnId || String(data.txnId) === String(record.txnId),
        authResult: data?.authResult,
        userCount: users.length,
        hasToken: Boolean(tokens.token),
        tokenFingerprint: tokenFingerprint(tokens.token),
        expiresIn: tokens.expiresIn,
        hasRefreshToken: Boolean(tokens.refreshToken),
        finalTokenShape: isFinalPhrTokenSet(tokens)
      });
    }

    if (!tokens.token) {
      const error = new Error('ABDM PHR verification did not return a login token');
      error.statusCode = 502;
      error.details = { authResult: data?.authResult, userCount: users.length };
      throw error;
    }

    // Some ABDM PHR responses already contain the final X-token and refresh
    // token. Do not send that token to Verify User as a T-token.
    if (isFinalPhrTokenSet(tokens)) {
      const profile = await fetchPhrProfile(tokens.token);
      return res.json(await finishPhrPortalLogin(record, data, profile));
    }

    if (!users.length) {
      const error = new Error('ABDM PHR did not return an ABHA Address to select');
      error.statusCode = 502;
      throw error;
    }

    const ttlSeconds = Math.max(30, Math.min(Number(tokens.expiresIn || 300), 600));
    record.status = 'WAITING';
    record.expiresAt = new Date(Math.min(record.expiresAt.getTime(), Date.now() + ttlSeconds * 1000));
    record.metadata = {
      ...(record.metadata || {}),
      candidateAbhaAddresses: users.map((user) => user.abhaAddress),
      intermediateToken: encryptJson(
        { token: tokens.token },
        `patient-portal-abdm:${record.txnId}`
      )
    };
    await record.save();

    return res.json({
      success: true,
      selectionRequired: true,
      txnId: record.txnId,
      users,
      preferredAbhaAddress: String(data?.preferredAbhaAddress || '').trim().toLowerCase() || undefined,
      expiresIn: ttlSeconds
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.abhaNumberSelectUser = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({
      txnId: req.body.txnId,
      flow: 'ABHA_NUMBER_LOGIN'
    });
    if (!record || record.expiresAt <= new Date()) {
      return res.status(410).json({ success: false, error: 'ABHA Number login transaction expired' });
    }
    if (!record.metadata?.intermediateToken) {
      return res.status(409).json({ success: false, error: 'No pending PHR ABHA Address selection exists' });
    }

    const abhaAddress = String(req.body.abhaAddress || '').trim().toLowerCase();
    if (!abhaAddress || !abhaAddress.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid abhaAddress is required' });
    }

    const allowed = Array.isArray(record.metadata?.candidateAbhaAddresses)
      ? record.metadata.candidateAbhaAddresses.map((value) => String(value).trim().toLowerCase())
      : [];
    if (allowed.length && !allowed.includes(abhaAddress)) {
      return res.status(400).json({ success: false, error: 'Selected ABHA Address is not part of this verified login transaction' });
    }

    const decrypted = decryptJson(
      record.metadata.intermediateToken,
      `patient-portal-abdm:${record.txnId}`
    );
    const tToken = String(decrypted?.token || '').trim();
    const tokenResponse = await verifyPhrUserSelection(record, abhaAddress, tToken);
    const tokens = tokenSetFromResponse(tokenResponse);
    const profile = await fetchPhrProfile(tokens.token);
    return res.json(await finishPhrPortalLogin(record, tokenResponse, profile));
  } catch (error) {
    if (debugEnabled()) {
      console.error('PHR_ABHA_NUMBER_SELECT_USER_ERROR', {
        txnId: req.body.txnId,
        errorMessage: error.message,
        statusCode: error.statusCode,
        details: error.details
      });
    }
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};


exports.addressRequestOtp = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const address = String(req.body.abhaAddress || '').trim().toLowerCase();
    if (!address.includes('@')) return res.status(400).json({ success: false, error: 'A valid ABHA Address is required' });

    // Current PHR app test flow uses ABHA-linked mobile OTP for ABHA Address
    // login. Aadhaar is an authentication method for ABHA Number, not a
    // standalone PHR login identifier.
    const scope = ['abha-address-login', 'mobile-verify'];
    const data = await abdmPost('/v3/phr/app/login/request/otp', {
      scope,
      loginHint: 'abha-address',
      loginId: await encryptForPhr(address),
      otpSystem: 'abdm'
    });

    const record = await PatientPortalAbdmTransaction.create({
      hospitalId: hospital._id,
      flow: 'ABHA_ADDRESS_LOGIN',
      txnId: data.txnId,
      abhaAddress: address,
      status: 'WAITING',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      metadata: { scope, otpSystem: 'abdm', apiFamily: 'PHR_APP' }
    });
    return res.json({ success: true, txnId: record.txnId, message: data.message, expiresIn: 600 });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.addressVerifyOtp = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.body.txnId, flow: 'ABHA_ADDRESS_LOGIN' });
    if (!record || record.expiresAt <= new Date()) {
      return res.status(410).json({ success: false, error: 'ABHA Address login transaction expired' });
    }

    const otp = cleanDigits(req.body.otp);
    if (!otp) return res.status(400).json({ success: false, error: 'OTP is required' });

    const data = await abdmPost('/v3/phr/app/login/verify', {
      scope: record.metadata?.scope || ['abha-address-login', 'mobile-verify'],
      authData: {
        authMethods: ['otp'],
        otp: { txnId: record.txnId, otpValue: await encryptForPhr(otp) }
      }
    });

    if (String(data?.authResult || '').toLowerCase() !== 'success') {
      const error = new Error(data?.message || 'ABHA Address OTP verification failed');
      error.statusCode = 400;
      error.details = data;
      throw error;
    }

    const tokens = tokenSetFromResponse(data);
    let tokenResponse = data;

    if (!isFinalPhrTokenSet(tokens)) {
      if (!tokens.token) {
        const error = new Error('ABDM PHR verification did not return a login token');
        error.statusCode = 502;
        throw error;
      }
      // The ABHA Address was already explicitly chosen before OTP request, so
      // if ABDM returns a temporary T-token, complete that same user selection
      // server-side without asking the patient to select it again.
      tokenResponse = await verifyPhrUserSelection(record, record.abhaAddress, tokens.token);
    }

    const finalTokens = tokenSetFromResponse(tokenResponse);
    const profile = await fetchPhrProfile(finalTokens.token);
    return res.json(await finishPhrPortalLogin(record, tokenResponse, profile));
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};


exports.faceSearch = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const mobile = cleanDigits(req.body.mobile).slice(-10);
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ success: false, error: 'A valid mobile number is required' });
    const data = await abdmPost('/v3/profile/account/abha/search', { scope: ['search-abha'], mobile: await encryptForAbdm(mobile) });
    return res.json({ success: true, hospitalId: hospital._id, txnId: data.txnId, accounts: data.ABHA || data.abha || data.accounts || [] });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.faceInit = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const searchTxnId = String(req.body.searchTxnId || '');
    const selectedIndex = String(req.body.index ?? '');
    if (!searchTxnId || selectedIndex === '') return res.status(400).json({ success: false, error: 'searchTxnId and account index are required' });
    const data = await abdmPost('/v3/profile/login/request/otp', {
      scope: ['abha-login', 'search-abha', 'face-auth'], loginHint: 'index', loginId: await encryptForAbdm(selectedIndex), otpSystem: 'aadhaar', txnId: searchTxnId
    });
    const txnId = data.txnId;
    const record = await PatientPortalAbdmTransaction.create({ hospitalId: hospital._id, flow: 'FACE_LOGIN', txnId, parentTxnId: searchTxnId, selectedIndex, status: 'WAITING', expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    const qrUrl = `${String(process.env.ABDM_PHR_FACE_AUTH_URL || 'https://phrsbx.abdm.gov.in/face-auth').replace(/\/$/, '')}?txnId=${encodeURIComponent(txnId)}`;
    return res.json({ success: true, txnId: record.txnId, qrUrl, expiresIn: 600, message: data.message });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.faceStatus = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.params.txnId, flow: 'FACE_LOGIN' });
    if (!record || record.expiresAt <= new Date()) return res.status(410).json({ success: false, error: 'Face authentication transaction expired' });
    const data = await abdmPost('/v3/enrollment/enrol/capturePID', { scope: ['abha-enrol', 'face-verify'], txnId: record.txnId });
    const status = String(data.status || '').toUpperCase();
    record.status = ['PENDING','VERIFIED'].includes(status) ? 'WAITING' : ['COMPLETE'].includes(status) ? 'COMPLETE' : status === 'FAILED' ? 'FAILED' : record.status;
    record.metadata = { ...(record.metadata || {}), captureStatus: status, captureMessage: data.message }; await record.save();
    return res.json({ success: true, txnId: record.txnId, status, message: data.message });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.faceComplete = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.body.txnId, flow: 'FACE_LOGIN' });
    if (!record || record.status !== 'COMPLETE') return res.status(409).json({ success: false, error: 'Face capture is not complete yet' });
    const data = await abdmPost('/v3/profile/login/verify', { scope: ['abha-login', 'aadhaar-face-verify'], authData: { authMethods: ['face_auth'], face: { txnId: record.txnId } } });
    return res.json(await finishVerifiedPortalLogin(record, data));
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.me = async (req, res) => res.json({ success: true, patient: patientLabel(req.patient) });
