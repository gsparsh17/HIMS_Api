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
const { withPatientAccessToken } = require('../services/abdmCredential.service');
const { masterRequest } = require('../services/abdmMasterClient.service');

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
  const [consents, records, subscriptions] = await Promise.all([
    AbdmHospitalConsent.find({ hospitalId: h, patientId: p }).sort({ createdAt: -1 }).limit(100).lean(),
    AbdmImportedRecord.find({ hospitalId: h, patientId: p, status: 'ACTIVE' }).select('-encryptedFhirBundle').sort({ recordDate: -1, createdAt: -1 }).limit(200).lean(),
    AbdmSubscription.find({ hospitalId: h, patientId: p }).sort({ createdAt: -1 }).limit(100).lean()
  ]);
  res.json({ success: true, abha: req.patient.abha, consents, records, subscriptions });
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
  return withPatientAccessToken(req.patient._id, token => masterRequest('/internal/abdm/m3/action', { method: 'POST', body: { action, authToken: token, resourceId, lockerId, body, query } }));
}
exports.subscriptionRequests = async (req, res) => { try { const r = await patientAbdmAction(req, 'PATIENT_SUBSCRIPTION_REQUESTS', { query: req.query }); res.json({ success: true, data: r.data, requestId: r.requestId }); } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); } };
exports.approveSubscription = async (req, res) => { try { const r = await patientAbdmAction(req, 'APPROVE_SUBSCRIPTION', { resourceId: req.params.id, body: req.body }); res.status(202).json({ success: true, data: r.data, requestId: r.requestId }); } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); } };
exports.denySubscription = async (req, res) => { try { const r = await patientAbdmAction(req, 'DENY_SUBSCRIPTION', { resourceId: req.params.id, body: { reason: req.body.reason || 'Not approved' } }); res.status(202).json({ success: true, data: r.data, requestId: r.requestId }); } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); } };
exports.healthLockers = async (req, res) => { try { const r = await patientAbdmAction(req, 'LIST_PATIENT_LOCKERS', { query: req.query }); res.json({ success: true, data: r.data, requestId: r.requestId }); } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); } };
