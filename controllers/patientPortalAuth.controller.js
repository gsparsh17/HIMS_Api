const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Hospital = require('../models/Hospital');
const Patient = require('../models/Patient');
const PatientPortalOtp = require('../models/PatientPortalOtp');
const PatientPortalAbdmTransaction = require('../models/PatientPortalAbdmTransaction');
const { sendPortalOtp } = require('../services/patientPortalSms.service');
const { encryptForAbdm, abdmPost } = require('../services/abdm.service');
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
    refreshExpiresIn: data.refreshExpiresIn
  };
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
  const tokens = tokenSetFromResponse(data);
  if (tokens.token) await storePatientSession({ patient, tokens });
  record.status = 'VERIFIED';
  record.selectedAbhaNumber = abhaNumber;
  record.abhaAddress = abhaAddress;
  await record.save();
  return { success: true, token: issuePatientToken(patient), patient: patientLabel(patient), abha: { number: abhaNumber, address: abhaAddress } };
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


exports.aadhaarRequestOtp = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const aadhaar = cleanDigits(req.body.aadhaarNumber);
    if (!/^\d{12}$/.test(aadhaar)) return res.status(400).json({ success: false, error: 'A valid 12-digit Aadhaar number is required' });
    const data = await abdmPost('/v3/profile/login/request/otp', {
      scope: ['abha-login', 'aadhaar-verify'],
      loginHint: 'aadhaar',
      loginId: await encryptForAbdm(aadhaar),
      otpSystem: 'aadhaar'
    });
    const record = await PatientPortalAbdmTransaction.create({ hospitalId: hospital._id, flow: 'AADHAAR_LOGIN', txnId: data.txnId, status: 'WAITING', expiresAt: new Date(Date.now() + 10 * 60 * 1000), metadata: { scope: ['abha-login', 'aadhaar-verify'] } });
    return res.json({ success: true, txnId: record.txnId, message: data.message, expiresIn: 600 });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.aadhaarVerifyOtp = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.body.txnId, flow: 'AADHAAR_LOGIN' });
    if (!record || record.expiresAt <= new Date()) return res.status(410).json({ success: false, error: 'Aadhaar login transaction expired' });
    const otp = cleanDigits(req.body.otp);
    if (!otp) return res.status(400).json({ success: false, error: 'OTP is required' });
    const data = await abdmPost('/v3/profile/login/verify', {
      scope: record.metadata?.scope || ['abha-login', 'aadhaar-verify'],
      authData: { authMethods: ['otp'], otp: { txnId: record.txnId, otpValue: await encryptForAbdm(otp) } }
    });
    const profile = profileFromResponse(data); const tokens = tokenSetFromResponse(data);
    if ((profile.ABHANumber || profile.abhaNumber || profile.preferredAddress || profile.abhaAddress) && tokens.token) {
      return res.json(await finishVerifiedPortalLogin(record, data));
    }
    const accounts = data.accounts || data.ABHA || data.abha || [];
    const intermediateToken = data.token || data.tToken || data.tokens?.token;
    if (!intermediateToken || !Array.isArray(accounts) || !accounts.length) throw new Error('ABDM did not return a selectable ABHA account');
    record.status = 'COMPLETE';
    record.metadata = { ...(record.metadata || {}), intermediateToken: encryptJson({ token: intermediateToken }, `patient-portal-abdm:${record.txnId}`) };
    await record.save();
    return res.json({ success: true, selectionRequired: true, txnId: record.txnId, accounts });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.aadhaarSelectUser = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.body.txnId, flow: 'AADHAAR_LOGIN' });
    if (!record?.metadata?.intermediateToken) return res.status(409).json({ success: false, error: 'No pending ABHA profile selection exists' });
    const { token } = decryptJson(record.metadata.intermediateToken, `patient-portal-abdm:${record.txnId}`);
    const abhaNumber = String(req.body.abhaNumber || '').trim();
    if (!abhaNumber) return res.status(400).json({ success: false, error: 'abhaNumber is required' });
    const data = await abdmPost('/v3/profile/login/verify/user', { ABHANumber: abhaNumber, txnId: record.txnId }, { 'T-token': `Bearer ${token}` });
    return res.json(await finishVerifiedPortalLogin(record, data));
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.addressRequestOtp = async (req, res) => {
  try {
    const hospital = await hospitalForPublicRequest(req);
    const address = String(req.body.abhaAddress || '').trim().toLowerCase();
    if (!address.includes('@')) return res.status(400).json({ success: false, error: 'A valid ABHA Address is required' });
    const method = String(req.body.otpSystem || 'abdm').toLowerCase() === 'aadhaar' ? 'aadhaar' : 'abdm';
    await abdmPost('/v3/phr/web/login/abha/search', { abhaAddress: address });
    const scope = ['abha-address-login', method === 'aadhaar' ? 'aadhaar-verify' : 'mobile-verify'];
    const data = await abdmPost('/v3/phr/web/login/abha/request/otp', {
      scope, loginHint: 'abha-address', loginId: await encryptForAbdm(address), otpSystem: method
    });
    const record = await PatientPortalAbdmTransaction.create({ hospitalId: hospital._id, flow: 'ABHA_ADDRESS_LOGIN', txnId: data.txnId, abhaAddress: address, status: 'WAITING', expiresAt: new Date(Date.now() + 10 * 60 * 1000), metadata: { scope, otpSystem: method } });
    return res.json({ success: true, txnId: record.txnId, message: data.message, expiresIn: 600 });
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
};

exports.addressVerifyOtp = async (req, res) => {
  try {
    const record = await PatientPortalAbdmTransaction.findOne({ txnId: req.body.txnId, flow: 'ABHA_ADDRESS_LOGIN' });
    if (!record || record.expiresAt <= new Date()) return res.status(410).json({ success: false, error: 'ABHA Address login transaction expired' });
    const data = await abdmPost('/v3/phr/web/login/abha/verify', {
      scope: record.metadata?.scope,
      authData: { authMethods: ['otp'], otp: { txnId: record.txnId, otpValue: await encryptForAbdm(cleanDigits(req.body.otp)) } }
    });
    return res.json(await finishVerifiedPortalLogin(record, data));
  } catch (error) { return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details }); }
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
