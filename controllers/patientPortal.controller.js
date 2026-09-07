const crypto = require('crypto');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const IPDAdmission = require('../models/IPDAdmission');
const IPDConsent = require('../models/IPDConsent');
const LabReport = require('../models/LabReport');
const ClinicalDocument = require('../models/ClinicalDocument');
const EncounterDocument = require('../models/EncounterDocument');
const Bill = require('../models/Bill');
const PatientExperienceResponse = require('../models/PatientExperienceResponse');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const AbdmImportedRecord = require('../models/AbdmImportedRecord');
const AbdmSubscription = require('../models/AbdmSubscription');
const { decryptJson } = require('../services/abdmVault.service');
const { withPatientAccessToken, getPatientSessionStatus } = require('../services/abdmCredential.service');
const { masterRequest } = require('../services/abdmMasterClient.service');
const { abdmPost, abdmGet, encryptForPhr } = require('../services/abdm.service');

const patientFilter = (req) => ({ hospitalId: req.patient.hospitalId, patientId: req.patient._id });

exports.dashboard = async (req, res) => {
  try {
    const p = req.patient._id, h = req.patient.hospitalId, now = new Date();
    const [upcoming, recentRx, activeAdmission, reportCount, consentCount, abdmCount] = await Promise.all([
      Appointment.findOne({ hospital_id: h, patient_id: p, appointment_date: { $gte: now }, status: { $ne: 'Cancelled' } }).populate('doctor_id','name first_name last_name').populate('department_id','name').sort({ appointment_date: 1 }).lean(),
      Prescription.findOne({ patient_id: p }).populate('doctor_id','name first_name last_name').sort({ issue_date: -1 }).lean(),
      IPDAdmission.findOne({ hospitalId: h, patientId: p, status: { $nin: ['Discharged','Cancelled','LAMA','DAMA','Expired'] } }).populate('primaryDoctorId','name first_name last_name').lean(),
      LabReport.countDocuments({ hospitalId: h, patient_id: p }),
      IPDConsent.countDocuments({ hospitalId: h, patientId: p, status: { $in: ['Draft','Completed'] } }),
      AbdmImportedRecord.countDocuments({ hospitalId: h, patientId: p, status: 'ACTIVE' })
    ]);
    return res.json({ success: true, patient: { id: p, name: [req.patient.first_name,req.patient.middle_name,req.patient.last_name].filter(Boolean).join(' '), uhid: req.patient.uhid || req.patient.patientId, abha: req.patient.abha }, cards: { upcomingAppointment: upcoming, recentPrescription: recentRx, activeAdmission, reportCount, pendingConsentCount: consentCount, abdmRecordCount: abdmCount } });
  } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
};

exports.appointments = async (req, res) => {
  const items = await Appointment.find({ hospital_id: req.patient.hospitalId, patient_id: req.patient._id }).populate('doctor_id','name first_name last_name').populate('department_id','name').sort({ appointment_date: -1 }).limit(200).lean();
  res.json({ success: true, appointments: items });
};
exports.prescriptions = async (req, res) => {
  const items = await Prescription.find({ patient_id: req.patient._id }).populate('doctor_id','name first_name last_name specialization').sort({ issue_date: -1 }).limit(200).lean();
  res.json({ success: true, prescriptions: items });
};
exports.medications = async (req, res) => {
  const rows = await Prescription.find({ patient_id: req.patient._id, status: { $in: ['Active','Completed'] } }).select('prescription_number issue_date status items').sort({ issue_date: -1 }).limit(100).lean();
  const medications = rows.flatMap(rx => (rx.items || []).map(item => ({ ...item, prescriptionId: rx._id, prescriptionNumber: rx.prescription_number, issueDate: rx.issue_date, prescriptionStatus: rx.status })));
  res.json({ success: true, medications });
};
exports.admissions = async (req, res) => {
  const items = await IPDAdmission.find(patientFilter(req)).populate('primaryDoctorId','name first_name last_name').populate('departmentId','name').populate('wardId','name').populate('roomId','room_number name').populate('bedId','bed_number name').sort({ admissionDate: -1 }).limit(100).lean();
  res.json({ success: true, admissions: items });
};
exports.reports = async (req, res) => {
  const lab = await LabReport.find({ hospitalId: req.patient.hospitalId, patient_id: req.patient._id }).sort({ report_date: -1 }).limit(200).lean();
  res.json({ success: true, labReports: lab });
};

exports.documents = async (req, res) => {
  const [clinical, encounter] = await Promise.all([
    ClinicalDocument.find({ patientId: req.patient._id, status: { $ne: 'entered-in-error' } }).sort({ documentDate: -1 }).limit(200).lean(),
    EncounterDocument.find({ hospitalId: req.patient.hospitalId, patientId: req.patient._id, status: { $nin: ['Entered in Error','Superseded'] }, visibility: { $ne: 'restricted' } }).sort({ documentDate: -1 }).limit(200).lean()
  ]);
  const documents = [
    ...clinical.map(d => ({ ...d, sourceKind: 'clinical' })),
    ...encounter.map(d => ({ ...d, sourceKind: 'encounter' }))
  ].sort((a,b) => new Date(b.documentDate || b.createdAt) - new Date(a.documentDate || a.createdAt));
  res.json({ success: true, documents });
};

exports.bills = async (req, res) => {
  const bills = await Bill.find({ hospital_id: req.patient.hospitalId, patient_id: req.patient._id })
    .select('-deletion_request')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json({ success: true, bills });
};

exports.consents = async (req, res) => {
  const items = await IPDConsent.find(patientFilter(req)).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ success: true, consents: items });
};
exports.updateConsentResponses = async (req, res) => {
  try {
    const consent = await IPDConsent.findOne({ _id: req.params.consentId, ...patientFilter(req) });
    if (!consent) return res.status(404).json({ success: false, error: 'Consent form not found' });
    if (['Signed','Revoked'].includes(consent.status)) return res.status(409).json({ success: false, error: `Consent is already ${consent.status.toLowerCase()}` });
    const responses = req.body.responses;
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return res.status(400).json({ success: false, error: 'responses must be an object' });
    // Patient-entered answers are merged into the form snapshot; identity/audit fields are added only at signing time.
    consent.responses = { ...(consent.responses || {}), ...responses, patientPortalLastSavedAt: new Date() };
    if (consent.status === 'Draft') consent.status = 'Completed';
    consent.completedAt = new Date();
    await consent.save();
    return res.json({ success: true, consent });
  } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
};

exports.signConsent = async (req, res) => {
  try {
    const consent = await IPDConsent.findOne({ _id: req.params.consentId, ...patientFilter(req) });
    if (!consent) return res.status(404).json({ success: false, error: 'Consent form not found' });
    if (['Signed','Revoked'].includes(consent.status)) return res.status(409).json({ success: false, error: `Consent is already ${consent.status.toLowerCase()}` });
    const accepted = req.body.accepted === true;
    if (!accepted) return res.status(400).json({ success: false, error: 'Explicit consent acceptance is required' });
    const signatureData = String(req.body.signatureData || req.body.typedName || '').trim();
    if (!signatureData) return res.status(400).json({ success: false, error: 'Signature is required' });
    consent.responses = { ...(consent.responses || {}), patientPortalAccepted: true, patientPortalAcceptedAt: new Date() };
    consent.signatures.push({ role: 'patient', name: req.body.typedName || [req.patient.first_name, req.patient.last_name].filter(Boolean).join(' '), signedAt: new Date(), method: req.body.method === 'drawn' ? 'drawn' : 'typed', capturedData: signatureData });
    consent.status = 'Signed'; consent.finalizedAt = new Date();
    consent.notes = [consent.notes, `Patient portal audit ${crypto.createHash('sha256').update(`${req.ip}|${req.headers['user-agent'] || ''}|${Date.now()}`).digest('hex')}`].filter(Boolean).join('\n');
    await consent.save();
    return res.json({ success: true, consent });
  } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
};
exports.submitFeedback = async (req, res) => {
  try {
    const referenceNumber = `PFB-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const item = await PatientExperienceResponse.create({ hospitalId: req.patient.hospitalId, referenceNumber, responseType: req.body.responseType || 'feedback', patientId: req.patient._id, responses: req.body.ratings || req.body.responses || {}, score: req.body.score, category: req.body.category, comments: req.body.comments, source: 'portal' });
    res.status(201).json({ success: true, feedback: item });
  } catch (error) { res.status(400).json({ success: false, error: error.message }); }
};
exports.abdmOverview = async (req, res) => {
  const h = req.patient.hospitalId, p = req.patient._id;
  const [consents, records, subscriptions, phrSession] = await Promise.all([
    AbdmHospitalConsent.find({ hospitalId: h, patientId: p }).sort({ createdAt: -1 }).limit(100).lean(),
    AbdmImportedRecord.find({ hospitalId: h, patientId: p, status: 'ACTIVE' }).select('-encryptedFhirBundle').sort({ recordDate: -1, createdAt: -1 }).limit(200).lean(),
    AbdmSubscription.find({ hospitalId: h, patientId: p }).sort({ createdAt: -1 }).limit(100).lean(),
    getPatientSessionStatus(p, 'PHR_APP')
  ]);
  res.json({
    success: true,
    abha: req.patient.abha,
    consents,
    records,
    subscriptions,
    phrSession,
    phrConsentCapabilities: {
      remoteInbox: true,
      requestDetail: true,
      deny: true,
      revoke: true,
      autoApprovePolicy: true,
      manualSingleRequestGrant: false,
      manualSingleRequestGrantReason:
        'The supplied ABDM PHR V3 contract exposes list/detail, deny, revoke and auto-approve-policy APIs, but does not define a patient POST endpoint that grants one existing consent request. This portal will not fake GRANTED by mutating local Mongo.'
    }
  });
};
exports.abdmRecord = async (req, res) => {
  try {
    const record = await AbdmImportedRecord.findOne({ _id: req.params.recordId, ...patientFilter(req), status: 'ACTIVE' }).select('+encryptedFhirBundle +encryptedFhirBundle.ciphertext +encryptedFhirBundle.iv +encryptedFhirBundle.tag');
    if (!record) return res.status(404).json({ success: false, error: 'ABDM record not found' });
    const bundle = decryptJson(record.encryptedFhirBundle, `abdm-imported-record:${record.hospitalId}:${record.transactionId}:${record.bundleHash}`);
    res.json({ success: true, record: { ...record.toObject(), encryptedFhirBundle: undefined }, bundle });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
};
async function patientAbdmAction(req, action, { resourceId, lockerId, body, query } = {}) {
  return withPatientAccessToken(
    req.patient._id,
    token => masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action, authToken: token, resourceId, lockerId, body, query }
    }),
    { sessionKind: 'PHR_APP' }
  );
}

function sendPatientAbdmError(res, error, fallbackStatus = 400) {
  return res.status(error.statusCode || fallbackStatus).json({
    success: false,
    code: error.code,
    error: error.message,
    details: error.details
  });
}

function consentRequestIdOf(value = {}) {
  return String(
    value.requestId ||
    value.consentRequestId ||
    value.id ||
    value.consentRequest?.id ||
    ''
  ).trim();
}

function remoteConsentRequests(data) {
  const candidates = [
    data?.requests,
    data?.consentRequests,
    data?.data?.requests,
    data?.result?.requests,
    data?.response?.requests
  ];
  const rows = candidates.find(Array.isArray) || [];
  return rows.filter((item) => item && typeof item === 'object');
}

function normalizeConsentQuery(query = {}) {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  const status = String(query.status || 'ALL').toUpperCase();
  const allowedStatuses = new Set([
    'ALL', 'REQUESTED', 'PENDING', 'GRANTED', 'DENIED', 'REVOKED', 'EXPIRED'
  ]);
  return {
    limit,
    offset,
    status: allowedStatuses.has(status) ? status : 'ALL'
  };
}

async function localConsentMap(req, ids = []) {
  const clean = [...new Set(ids.map(String).map((value) => value.trim()).filter(Boolean))];
  if (!clean.length) return new Map();
  const rows = await AbdmHospitalConsent.find({
    hospitalId: req.patient.hospitalId,
    patientId: req.patient._id,
    role: 'HIU',
    consentRequestId: { $in: clean }
  })
    .select('_id consentRequestId consentId status purpose hiTypes permission expiresAt lastCallbackAt metadata')
    .lean();
  return new Map(rows.map((row) => [String(row.consentRequestId), row]));
}

exports.abdmConsentRequests = async (req, res) => {
  try {
    const query = normalizeConsentQuery(req.query);
    const r = await patientAbdmAction(req, 'LIST_CONSENT_REQUESTS', { query });
    const requests = remoteConsentRequests(r.data);
    const local = await localConsentMap(req, requests.map(consentRequestIdOf));
    return res.json({
      success: true,
      requestId: r.requestId,
      remote: r.data,
      requests: requests.map((item) => {
        const requestId = consentRequestIdOf(item);
        return {
          ...item,
          requestId,
          localConsent: local.get(requestId) || null
        };
      })
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.abdmConsentRequest = async (req, res) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId) return res.status(400).json({ success: false, error: 'Consent request ID is required' });
    const r = await patientAbdmAction(req, 'GET_CONSENT_REQUEST', { resourceId: requestId });
    const local = await localConsentMap(req, [requestId]);
    return res.json({
      success: true,
      requestId: r.requestId,
      consentRequestId: requestId,
      consentRequest: r.data,
      localConsent: local.get(requestId) || null
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.denyAbdmConsentRequest = async (req, res) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    const reason = String(req.body?.reason || 'Not authorized by patient').trim();
    if (!requestId) return res.status(400).json({ success: false, error: 'Consent request ID is required' });
    const r = await patientAbdmAction(req, 'DENY_CONSENT_REQUEST', {
      resourceId: requestId,
      body: { reason }
    });
    // Do not mutate the local HIU mirror to DENIED here. ABDM remains the
    // authority; the HIU /consent/request/notify callback will update lifecycle.
    return res.status(202).json({
      success: true,
      requestId: r.requestId,
      consentRequestId: requestId,
      data: r.data,
      message: 'Denial was submitted to ABDM. Local status will update from the ABDM HIU notification callback.'
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.abdmConsentArtefactsByRequest = async (req, res) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId) return res.status(400).json({ success: false, error: 'Consent request ID is required' });
    const r = await patientAbdmAction(req, 'GET_CONSENT_ARTEFACTS_BY_REQUEST', {
      resourceId: requestId
    });
    return res.json({ success: true, requestId: r.requestId, data: r.data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.abdmConsentArtefacts = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'LIST_CONSENT_ARTEFACTS', {
      query: normalizeConsentQuery(req.query)
    });
    return res.json({ success: true, requestId: r.requestId, data: r.data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.abdmConsentArtefact = async (req, res) => {
  try {
    const consentId = String(req.params.consentId || '').trim();
    if (!consentId) return res.status(400).json({ success: false, error: 'Consent artefact ID is required' });
    const r = await patientAbdmAction(req, 'GET_CONSENT_ARTEFACT', {
      resourceId: consentId
    });
    return res.json({ success: true, requestId: r.requestId, consentId, data: r.data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.revokeAbdmConsent = async (req, res) => {
  try {
    const consents = Array.isArray(req.body?.consents)
      ? req.body.consents.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    if (!consents.length) {
      return res.status(400).json({
        success: false,
        error: 'consents must contain at least one ABDM consent artefact ID'
      });
    }
    const r = await patientAbdmAction(req, 'REVOKE_CONSENT', {
      body: { consents }
    });
    // As with deny, wait for ABDM lifecycle notification before changing the
    // local mirror to REVOKED.
    return res.status(202).json({
      success: true,
      requestId: r.requestId,
      data: r.data,
      message: 'Revocation was submitted to ABDM. Local status will update from the ABDM callback.'
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.createAbdmConsentAutoApprove = async (req, res) => {
  try {
    const input = req.body || {};
    if (input.isApplicableForAllHIPs !== true && input.isApplicableForAllHIPs !== false) {
      return res.status(400).json({
        success: false,
        error: 'isApplicableForAllHIPs must be explicitly true or false'
      });
    }
    if (input.isApplicableForAllHIPs === true && input.confirmBroadScope !== true) {
      return res.status(400).json({
        success: false,
        code: 'ABDM_AUTO_APPROVE_BROAD_SCOPE_CONFIRMATION_REQUIRED',
        error:
          'This policy applies across all HIPs. Set confirmBroadScope=true only after the patient explicitly accepts that broader future auto-approval scope.'
      });
    }
    if (!input.hiu?.id) {
      return res.status(400).json({ success: false, error: 'hiu.id is required' });
    }
    if (!Array.isArray(input.includedSources) || !input.includedSources.length) {
      return res.status(400).json({ success: false, error: 'includedSources is required' });
    }

    const body = {
      isApplicableForAllHIPs: input.isApplicableForAllHIPs,
      hiu: { id: String(input.hiu.id) },
      includedSources: input.includedSources,
      excludedSources: Array.isArray(input.excludedSources) ? input.excludedSources : []
    };
    const r = await patientAbdmAction(req, 'CREATE_CONSENT_AUTO_APPROVE', { body });
    return res.status(202).json({
      success: true,
      requestId: r.requestId,
      data: r.data,
      message:
        'ABDM auto-approval policy was submitted. This policy governs future matching consent requests; it does not locally force the current request to GRANTED.'
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.disableAbdmConsentAutoApprove = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'DISABLE_CONSENT_AUTO_APPROVE', {
      resourceId: req.params.policyId
    });
    return res.status(202).json({ success: true, requestId: r.requestId, data: r.data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.enableAbdmConsentAutoApprove = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'ENABLE_CONSENT_AUTO_APPROVE', {
      resourceId: req.params.policyId
    });
    return res.status(202).json({ success: true, requestId: r.requestId, data: r.data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.subscriptionRequests = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'PATIENT_SUBSCRIPTION_REQUESTS', { query: req.query });
    res.json({ success: true, data: r.data, requestId: r.requestId });
  } catch (error) {
    sendPatientAbdmError(res, error);
  }
};
exports.approveSubscription = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'APPROVE_SUBSCRIPTION', { resourceId: req.params.id, body: req.body });
    res.status(202).json({ success: true, data: r.data, requestId: r.requestId });
  } catch (error) {
    sendPatientAbdmError(res, error);
  }
};
exports.denySubscription = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'DENY_SUBSCRIPTION', { resourceId: req.params.id, body: { reason: req.body.reason || 'Not approved' } });
    res.status(202).json({ success: true, data: r.data, requestId: r.requestId });
  } catch (error) {
    sendPatientAbdmError(res, error);
  }
};
exports.healthLockers = async (req, res) => {
  try {
    const r = await patientAbdmAction(req, 'LIST_PATIENT_LOCKERS', { query: req.query });
    res.json({ success: true, data: r.data, requestId: r.requestId });
  } catch (error) {
    sendPatientAbdmError(res, error);
  }
};


function parseFacilityShareTarget(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    return {
      hipId: String(url.searchParams.get('hipid') || url.searchParams.get('hipId') || '').trim(),
      context: String(url.searchParams.get('counterid') || url.searchParams.get('counterId') || url.searchParams.get('context') || '').trim()
    };
  } catch (_error) {
    const params = new URLSearchParams(raw.replace(/^\?/, ''));
    return {
      hipId: String(params.get('hipid') || params.get('hipId') || '').trim(),
      context: String(params.get('counterid') || params.get('counterId') || params.get('context') || '').trim()
    };
  }
}

function patientShareProfile(patient, officialProfile = {}) {
  const localDob = patient.dob ? new Date(patient.dob) : null;
  const validLocalDob = localDob && !Number.isNaN(localDob.getTime());
  const officialAbhaDigits = String(officialProfile.abhaNumber || '').replace(/\D/g, '');
  const localAbhaDigits = String(patient.abha?.number || '').replace(/\D/g, '');
  const officialMobileDigits = String(officialProfile.mobile || '').replace(/\D/g, '');
  const localMobileDigits = String(patient.phone || '').replace(/\D/g, '').slice(-10);
  const localAddressLine = [patient.address, patient.address_line1, patient.address_line2, patient.city]
    .filter(Boolean).join(', ');
  return {
    // PHR profile values are preferred for demographics. The local verified
    // mapping supplies full identifiers where the PHR get-profile response is
    // masked (as shown in the official PHR examples).
    abhaNumber: officialAbhaDigits.length === 14 ? officialAbhaDigits : localAbhaDigits,
    abhaAddress: String(officialProfile.abhaAddress || patient.abha?.address || '').trim().toLowerCase(),
    name: String(officialProfile.fullName || [officialProfile.firstName, officialProfile.middleName, officialProfile.lastName].filter(Boolean).join(' ') || [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')).trim(),
    gender: String(officialProfile.gender || patient.gender || '').trim().slice(0, 1).toUpperCase(),
    dayOfBirth: String(officialProfile.dayOfBirth || (validLocalDob ? localDob.getUTCDate() : '')),
    monthOfBirth: String(officialProfile.monthOfBirth || (validLocalDob ? localDob.getUTCMonth() + 1 : '')),
    yearOfBirth: String(officialProfile.yearOfBirth || (validLocalDob ? localDob.getUTCFullYear() : '')),
    address: {
      line: officialProfile.address || localAddressLine || null,
      district: officialProfile.districtName || patient.district || patient.districtName || null,
      state: officialProfile.stateName || patient.state || patient.stateName || null,
      pincode: officialProfile.pinCode || patient.pinCode || patient.pincode || patient.zipCode || null
    },
    phoneNumber: officialMobileDigits.length === 10 ? officialMobileDigits : localMobileDigits
  };
}

exports.abdmProfileShare = async (req, res) => {
  try {
    if (req.body?.consentAccepted !== true) {
      return res.status(400).json({ success: false, error: 'Explicit patient consent is required before sharing the ABDM profile' });
    }
    const parsed = parseFacilityShareTarget(req.body?.qrContent || req.body?.shareUrl);
    const hipId = String(req.body?.hipId || parsed.hipId || '').trim();
    const context = String(req.body?.context || parsed.context || '').trim();
    if (!hipId || !context) return res.status(400).json({ success: false, error: 'Facility HIP ID and counter context are required' });
    const officialProfile = await patientPhrCall(req, token => abdmGet('/v3/phr/app/login/profile', phrTokenHeader(token)));
    const profile = patientShareProfile(req.patient, officialProfile);
    if (!profile.abhaAddress) return res.status(409).json({ success: false, error: 'The patient must have a linked ABHA Address before Scan & Share' });
    const body = {
      intent: 'PROFILE_SHARE',
      metaData: {
        hipId,
        context,
        ...(req.body?.hprId ? { hprId: String(req.body.hprId) } : {}),
        ...(req.body?.latitude !== undefined ? { latitude: String(req.body.latitude) } : {}),
        ...(req.body?.longitude !== undefined ? { longitude: String(req.body.longitude) } : {})
      },
      profile: { patient: profile }
    };
    const r = await patientAbdmAction(req, 'PHR_PROFILE_SHARE', { body });
    return res.status(202).json({ success: true, requestId: r.requestId, data: r.data, hipId, context, message: 'Profile share submitted to ABDM' });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.abdmRunningTokenStatus = async (req, res) => {
  try {
    const parsed = parseFacilityShareTarget(req.body?.qrContent || req.body?.shareUrl);
    const hipId = String(req.body?.hipId || parsed.hipId || '').trim();
    const context = String(req.body?.context || parsed.context || '').trim();
    if (!hipId || !context) return res.status(400).json({ success: false, error: 'Facility HIP ID and counter context are required' });
    const r = await patientAbdmAction(req, 'REQUEST_RUNNING_TOKEN_STATUS', { body: { hipId, context } });
    return res.status(202).json({ success: true, requestId: r.requestId, data: r.data, hipId, context, message: 'Running-token status request submitted to ABDM' });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};


async function patientPhrCall(req, operation) {
  return withPatientAccessToken(
    req.patient._id,
    token => operation(token),
    { sessionKind: 'PHR_APP' }
  );
}

function phrTokenHeader(token) {
  return { 'X-token': `Bearer ${String(token || '').replace(/^Bearer\s+/i, '')}` };
}

exports.requestPhrProfileOtp = async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').trim().toLowerCase();
    const value = String(req.body?.value || '').trim();
    if (!['mobile', 'email'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'kind must be mobile or email' });
    }
    if (!value) return res.status(400).json({ success: false, error: `${kind} is required` });
    if (kind === 'mobile' && !/^\d{10}$/.test(value.replace(/\D/g, '').slice(-10))) {
      return res.status(400).json({ success: false, error: 'Enter a valid 10-digit mobile number' });
    }
    if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const normalizedValue = kind === 'mobile' ? value.replace(/\D/g, '').slice(-10) : value.toLowerCase();
    const encrypted = await encryptForPhr(normalizedValue);
    const data = await patientPhrCall(req, token => abdmPost(
      '/v3/phr/app/login/profile/request/otp',
      {
        scope: ['abha-address-profile', kind === 'mobile' ? 'mobile-verify' : 'email-verify'],
        loginHint: kind === 'mobile' ? 'mobile-number' : 'email',
        loginId: encrypted,
        otpSystem: 'abdm'
      },
      phrTokenHeader(token)
    ));
    return res.status(202).json({ success: true, txnId: data?.txnId || data?.transactionId, message: `Verification OTP sent for ${kind} update` });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.verifyPhrProfileOtp = async (req, res) => {
  try {
    const txnId = String(req.body?.txnId || '').trim();
    const otp = String(req.body?.otp || '').trim();
    const kind = String(req.body?.kind || '').trim().toLowerCase();
    if (!txnId || !otp || !['mobile', 'email'].includes(kind)) {
      return res.status(400).json({ success: false, error: 'txnId, otp and kind (mobile/email) are required' });
    }
    const encryptedOtp = await encryptForPhr(otp);
    const data = await patientPhrCall(req, token => abdmPost(
      '/v3/phr/app/login/profile/verify',
      {
        scope: ['abha-address-profile', kind === 'mobile' ? 'mobile-verify' : 'email-verify'],
        authData: {
          authMethods: ['otp'],
          otp: { txnId, otpValue: encryptedOtp }
        }
      },
      phrTokenHeader(token)
    ));
    return res.json({ success: true, data, message: `${kind === 'mobile' ? 'Mobile number' : 'Email'} updated in PHR profile` });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.updatePhrPassword = async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const abhaAddress = String(req.body?.abhaAddress || req.patient?.abha?.address || '').trim().toLowerCase();
    if (!abhaAddress) return res.status(409).json({ success: false, error: 'No ABHA Address is linked to this patient' });
    if (password.length < 8) return res.status(400).json({ success: false, error: 'PHR password must be at least 8 characters' });
    const encryptedPassword = await encryptForPhr(password);
    const data = await patientPhrCall(req, token => abdmPost(
      '/v3/phr/app/login/profile/verify',
      {
        scope: ['abha-address-profile', 'password-verify'],
        authData: {
          authMethods: ['password'],
          password: { abhaAddress, password: encryptedPassword }
        }
      },
      phrTokenHeader(token)
    ));
    return res.json({ success: true, data, message: 'PHR password updated' });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.getPhrProfile = async (req, res) => {
  try {
    const data = await patientPhrCall(req, token => abdmGet(
      '/v3/phr/app/login/profile',
      phrTokenHeader(token)
    ));
    return res.json({ success: true, profile: data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.updatePhrProfile = async (req, res) => {
  try {
    const incoming = req.body || {};
    const editable = [
      'profilePhoto', 'firstName', 'middleName', 'lastName',
      'dayOfBirth', 'monthOfBirth', 'yearOfBirth', 'gender',
      'address', 'stateName', 'districtName', 'pinCode', 'stateCode', 'districtCode'
    ];
    if (!editable.some((key) => Object.prototype.hasOwnProperty.call(incoming, key))) {
      return res.status(400).json({ success: false, error: 'No supported PHR profile fields were supplied' });
    }

    // PHR V3 updateProfile expects a complete profile body. Fetch the current
    // logged-in profile first and merge only fields this endpoint may change.
    // Email/mobile stay on their dedicated OTP-verification paths.
    const result = await patientPhrCall(req, async (token) => {
      const headers = phrTokenHeader(token);
      const current = await abdmGet('/v3/phr/app/login/profile', headers);
      const kycVerified = ['VERIFIED', 'KYC_VERIFIED', 'TRUE'].includes(String(current?.kycStatus || '').toUpperCase());
      const kycLocked = new Set(['firstName', 'middleName', 'lastName', 'dayOfBirth', 'monthOfBirth', 'yearOfBirth', 'gender']);
      const payload = {
        profilePhoto: current?.profilePhoto || '',
        firstName: current?.firstName || '',
        middleName: current?.middleName || '',
        lastName: current?.lastName || '',
        dayOfBirth: String(current?.dayOfBirth || ''),
        monthOfBirth: String(current?.monthOfBirth || ''),
        yearOfBirth: String(current?.yearOfBirth || ''),
        gender: current?.gender || '',
        email: current?.email || '',
        mobile: current?.mobile || '',
        address: current?.address || '',
        stateName: current?.stateName || '',
        districtName: current?.districtName || '',
        pinCode: String(current?.pinCode || ''),
        stateCode: String(current?.stateCode || ''),
        districtCode: String(current?.districtCode || '')
      };
      for (const key of editable) {
        if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
        if (kycVerified && kycLocked.has(key)) continue;
        payload[key] = incoming[key] == null ? '' : String(incoming[key]);
      }
      const updated = await abdmPost('/v3/phr/app/login/profile/updateProfile', payload, headers);
      return { profile: updated, kycLocked: kycVerified };
    });
    return res.json({ success: true, data: result.profile, kycLocked: result.kycLocked, message: 'PHR profile updated in ABDM' });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.getPhrQrCode = async (req, res) => {
  try {
    const data = await patientPhrCall(req, token => abdmGet(
      '/v3/phr/app/login/profile/qrCode',
      phrTokenHeader(token)
    ));
    return res.json({ success: true, data });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};

exports.getPhrCard = async (req, res) => {
  try {
    const result = await patientPhrCall(req, token => abdmGet(
      '/v3/phr/app/login/profile/phrCard',
      phrTokenHeader(token),
      'buffer'
    ));
    return res.json({
      success: true,
      contentType: result.contentType || 'application/octet-stream',
      dataBase64: result.buffer.toString('base64')
    });
  } catch (error) {
    return sendPatientAbdmError(res, error);
  }
};
