const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const AbdmHiuRequest = require('../models/AbdmHiuRequest');
const AbdmImportedRecord = require('../models/AbdmImportedRecord');
const AbdmSubscription = require('../models/AbdmSubscription');
const abdmConfig = require('../config/abdm.config');
const {
  initiateConsent,
  requestConsentStatus,
  fetchConsentArtefact,
  initiateHealthInformationRequest
} = require('../services/abdmHiuHospital.service');
const { assertConsentUsable } = require('../services/abdmConsentPolicy.service');
const { recordAccess } = require('../services/abdmAccessAudit.service');
const { masterRequest } = require('../services/abdmMasterClient.service');
const { decryptJson } = require('../services/abdmVault.service');
const Patient = require('../models/Patient');
const { assertUserHospital, assertSameHospital } = require('../utils/hospitalScope');

function pagination(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  return { page, limit, skip: (page - 1) * limit };
}

exports.createConsentRequest = async (req, res) => {
  try {
    const { patientId, ...payload } = req.body || {};
    if (!patientId) {
      return res.status(400).json({ success: false, error: 'patientId is required' });
    }
    const result = await initiateConsent({ patientId, payload, user: req.user });
    await recordAccess(req, {
      action: 'CONSENT_REQUEST',
      patientId,
      consentId: result.consent.consentId,
      metadata: { consentRequestId: result.consent.consentRequestId }
    });
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.listConsents = async (req, res) => {
  const { page, limit, skip } = pagination(req);
  const filter = { hospitalId: assertUserHospital(req.user), role: 'HIU' };
  if (req.query.patientId) filter.patientId = req.query.patientId;
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  const [items, total] = await Promise.all([
    AbdmHospitalConsent.find(filter)
      .select('-encryptedArtefact')
      .populate('patientId', 'patientId uhid first_name middle_name last_name abha')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AbdmHospitalConsent.countDocuments(filter)
  ]);
  return res.json({ success: true, page, limit, total, consents: items });
};

exports.getConsent = async (req, res) => {
  const consent = await AbdmHospitalConsent.findOne({
    _id: req.params.consentId,
    hospitalId: assertUserHospital(req.user),
    role: 'HIU'
  })
    .select('-encryptedArtefact')
    .populate('patientId', 'patientId uhid first_name middle_name last_name abha')
    .lean();
  if (!consent) return res.status(404).json({ success: false, error: 'Consent not found' });
  return res.json({ success: true, consent });
};

exports.refreshConsentStatus = async (req, res) => {
  try {
    const consent = await AbdmHospitalConsent.findOne({
      _id: req.params.consentId,
      hospitalId: assertUserHospital(req.user),
      role: 'HIU'
    });
    if (!consent) return res.status(404).json({ success: false, error: 'Consent not found' });
    const result = await requestConsentStatus(consent);
    return res.status(202).json({ success: true, requestId: result.requestId });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.fetchConsent = async (req, res) => {
  try {
    const consent = await AbdmHospitalConsent.findOne({
      _id: req.params.consentId,
      hospitalId: assertUserHospital(req.user),
      role: 'HIU'
    });
    if (!consent) return res.status(404).json({ success: false, error: 'Consent not found' });
    const result = await fetchConsentArtefact(consent);
    return res.status(202).json({ success: true, requestId: result.requestId });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.requestHealthInformation = async (req, res) => {
  try {
    const consent = await AbdmHospitalConsent.findOne({
      _id: req.params.consentId,
      hospitalId: assertUserHospital(req.user),
      role: 'HIU'
    });
    if (!consent) return res.status(404).json({ success: false, error: 'Consent not found' });
    const result = await initiateHealthInformationRequest({ consent, user: req.user });
    await recordAccess(req, {
      action: 'HI_REQUEST',
      patientId: consent.patientId,
      consentId: consent.consentId,
      metadata: { requestId: result.request.requestId }
    });
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.listRequests = async (req, res) => {
  const { page, limit, skip } = pagination(req);
  const filter = { hospitalId: assertUserHospital(req.user) };
  if (req.query.patientId) filter.patientId = req.query.patientId;
  if (req.query.consentId) filter.consentId = req.query.consentId;
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  const [items, total] = await Promise.all([
    AbdmHiuRequest.find(filter)
      .select('-encryptedPrivateMaterial')
      .populate('patientId', 'patientId uhid first_name middle_name last_name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AbdmHiuRequest.countDocuments(filter)
  ]);
  return res.json({ success: true, page, limit, total, requests: items });
};

exports.listImportedRecords = async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { page, limit, skip } = pagination(req);
    const hospitalId = assertUserHospital(req.user);
    const patient = await Patient.findOne({ _id: patientId, hospitalId }).select('_id');
    if (!patient) return res.status(404).json({ success: false, error: 'Patient not found' });
    const filter = { hospitalId, patientId };
    if (req.query.hiType) filter.hiType = req.query.hiType;
    if (req.query.sourceHipId) filter.sourceHipId = req.query.sourceHipId;
    if (req.query.includeInactive !== 'true') filter.status = 'ACTIVE';
    const [items, total] = await Promise.all([
      AbdmImportedRecord.find(filter)
        .select('-encryptedFhirBundle')
        .sort({ recordDate: -1, importedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AbdmImportedRecord.countDocuments(filter)
    ]);
    await recordAccess(req, {
      action: 'LIST',
      patientId,
      metadata: { count: items.length }
    });
    return res.json({ success: true, page, limit, total, records: items });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.getImportedRecord = async (req, res) => {
  try {
    const record = await AbdmImportedRecord.findOne({
      _id: req.params.recordId,
      hospitalId: assertUserHospital(req.user)
    }).select(
      '+encryptedFhirBundle.ciphertext +encryptedFhirBundle.iv +encryptedFhirBundle.tag +encryptedFhirBundle.keyVersion'
    );
    if (!record) return res.status(404).json({ success: false, error: 'Imported record not found' });
    const consent = await AbdmHospitalConsent.findOne({
      hospitalId: record.hospitalId,
      role: 'HIU',
      consentId: record.consentId
    });
    assertConsentUsable(consent);
    if (record.status !== 'ACTIVE') {
      return res.status(410).json({ success: false, error: `Record is ${record.status}` });
    }
    await recordAccess(req, {
      action: 'VIEW',
      patientId: record.patientId,
      importedRecordId: record._id,
      consentId: record.consentId
    });
    const recordObject = record.toObject();
    recordObject.fhirBundle = decryptJson(
      record.encryptedFhirBundle,
      `abdm-imported-record:${record.hospitalId}:${record.transactionId}:${record.bundleHash}`
    );
    delete recordObject.encryptedFhirBundle;
    return res.json({ success: true, record: recordObject });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

exports.createSubscription = async (req, res) => {
  try {
    if (!abdmConfig.featureSubscriptions) {
      return res.status(409).json({ success: false, error: 'Subscriptions are disabled' });
    }
    const requestId = require('crypto').randomUUID();
    const patientId = req.body.patientId;
    const patient = await Patient.findById(patientId);
    if (!patient) throw new Error('Patient not found');
    const hospitalId = assertSameHospital(patient.hospitalId, req.user);
    const subscription = await AbdmSubscription.create({
      hospitalId,
      subscriptionRequestId: requestId,
      patientId,
      status: 'REQUESTED',
      hiTypes: req.body.hiTypes,
      categories: req.body.categories,
      period: req.body.period,
      createdBy: req.user._id
    });
    const body = {
      request: { id: requestId, timestamp: new Date().toISOString() },
      subscription: req.body.subscription || {
        patient: { id: req.body.abhaAddress },
        purpose: req.body.purpose,
        categories: req.body.categories,
        period: req.body.period
      }
    };
    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'INIT_SUBSCRIPTION', body }
    });
    subscription.metadata = { masterRequestId: master.requestId };
    await subscription.save();
    return res.status(202).json({ success: true, subscription });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.summary = async (req, res) => {
  const hospitalId = assertUserHospital(req.user);
  const [consents, requests, records, subscriptions] = await Promise.all([
    AbdmHospitalConsent.aggregate([
      { $match: { hospitalId, role: 'HIU' } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    AbdmHiuRequest.aggregate([{ $match: { hospitalId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    AbdmImportedRecord.aggregate([{ $match: { hospitalId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    AbdmSubscription.aggregate([{ $match: { hospitalId } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
  ]);
  return res.json({ success: true, consents, requests, records, subscriptions });
};
