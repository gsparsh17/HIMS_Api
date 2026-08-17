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
const { withPatientAccessToken } = require('../services/abdmCredential.service');
const { assertAbdmExchangeEligible } = require('../services/abdmExchangeEligibility.service');

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
  try {
    const { page, limit, skip } = pagination(req);
    const filter = {
      hospitalId: assertUserHospital(req.user),
      role: 'HIU'
    };
    if (req.query.patientId) filter.patientId = req.query.patientId;
    if (req.query.status) {
      filter.status = String(req.query.status).toUpperCase();
    }

    const [items, total] = await Promise.all([
      AbdmHospitalConsent.find(filter)
        .populate(
          'patientId',
          'patientId uhid first_name middle_name last_name abha'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AbdmHospitalConsent.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      consents: items
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.getConsent = async (req, res) => {
  try {
    const consent = await AbdmHospitalConsent.findOne({
      _id: req.params.consentId,
      hospitalId: assertUserHospital(req.user),
      role: 'HIU'
    })
      .populate(
        'patientId',
        'patientId uhid first_name middle_name last_name abha'
      )
      .lean();

    if (!consent) {
      return res.status(404).json({
        success: false,
        error: 'Consent not found'
      });
    }

    return res.json({ success: true, consent });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
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
  try {
    const { page, limit, skip } = pagination(req);
    const filter = { hospitalId: assertUserHospital(req.user) };
    if (req.query.patientId) filter.patientId = req.query.patientId;
    if (req.query.consentId) filter.consentId = req.query.consentId;
    if (req.query.status) {
      filter.status = String(req.query.status).toUpperCase();
    }

    const [items, total] = await Promise.all([
      AbdmHiuRequest.find(filter)
        .populate(
          'patientId',
          'patientId uhid first_name middle_name last_name'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AbdmHiuRequest.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      page,
      limit,
      total,
      requests: items
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
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
    assertAbdmExchangeEligible(patient);
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
      subscription: req.body.subscription || {
        patient: { id: req.body.abhaAddress || patient.abha.address },
        hiu: { id: abdmConfig.hiuId },
        purpose: req.body.purpose,
        categories: req.body.categories,
        period: req.body.period
      }
    };
    if (!body.subscription.hiu?.id) body.subscription.hiu = { id: abdmConfig.hiuId };
    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'INIT_SUBSCRIPTION', body }
    });
    const officialSubscriptionRequestId =
      master.data?.subscriptionRequestId ||
      master.data?.subscriptionRequest?.id;
    if (officialSubscriptionRequestId) {
      subscription.subscriptionRequestId = officialSubscriptionRequestId;
    }
    subscription.metadata = {
      masterRequestId: master.requestId,
      localRequestId: requestId,
      ...(officialSubscriptionRequestId ? { officialSubscriptionRequestId } : {})
    };
    await subscription.save();
    return res.status(202).json({ success: true, subscription });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};


function assertSubscriptionsEnabled() {
  if (!abdmConfig.featureSubscriptions) {
    const error = new Error('Subscriptions are disabled');
    error.statusCode = 409;
    throw error;
  }
}

async function subscriptionPatient(req) {
  const patient = await Patient.findById(req.body.patientId || req.query.patientId || req.params.patientId);
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }
  assertSameHospital(patient.hospitalId, req.user);
  assertAbdmExchangeEligible(patient);
  return patient;
}

async function patientAuthenticatedAction(req, action, extra = {}) {
  assertSubscriptionsEnabled();
  const patient = await subscriptionPatient(req);
  return withPatientAccessToken(
    patient._id,
    (token) => masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: {
        action,
        authToken: token,
        resourceId: extra.resourceId,
        lockerId: extra.lockerId,
        query: extra.query,
        body: extra.body
      }
    }),
    { updatedBy: req.user._id, sessionKind: 'PHR_APP' }
  );
}

exports.listHealthLockers = async (req, res) => {
  try {
    assertSubscriptionsEnabled();
    const result = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'LIST_HEALTH_LOCKERS', query: req.query }
    });
    return res.json({ success: true, requestId: result.requestId, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.listSubscriptions = async (req, res) => {
  try {
    assertSubscriptionsEnabled();
    const filter = { hospitalId: assertUserHospital(req.user) };
    if (req.query.patientId) filter.patientId = req.query.patientId;
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const subscriptions = await AbdmSubscription.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ success: true, subscriptions });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.approveSubscription = async (req, res) => {
  try {
    const result = await patientAuthenticatedAction(req, 'APPROVE_SUBSCRIPTION', {
      resourceId: req.params.subscriptionRequestId,
      body: req.body.approval || req.body.body || req.body
    });
    await AbdmSubscription.findOneAndUpdate(
      { hospitalId: assertUserHospital(req.user), subscriptionRequestId: req.params.subscriptionRequestId },
      { status: 'GRANTED', metadata: { approvedAt: new Date(), masterRequestId: result.requestId } }
    );
    return res.status(202).json({ success: true, requestId: result.requestId, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

exports.denySubscription = async (req, res) => {
  try {
    const result = await patientAuthenticatedAction(req, 'DENY_SUBSCRIPTION', {
      resourceId: req.params.subscriptionRequestId,
      body: { reason: req.body.reason || 'Not approved' }
    });
    await AbdmSubscription.findOneAndUpdate(
      { hospitalId: assertUserHospital(req.user), subscriptionRequestId: req.params.subscriptionRequestId },
      { status: 'DENIED', metadata: { deniedAt: new Date(), masterRequestId: result.requestId } }
    );
    return res.status(202).json({ success: true, requestId: result.requestId, data: result.data });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
  }
};

function remoteSubscriptionHandler(action, options = {}) {
  return async (req, res) => {
    try {
      const result = await patientAuthenticatedAction(req, action, {
        resourceId: options.resourceParam ? req.params[options.resourceParam] : undefined,
        lockerId: options.lockerParam ? req.params[options.lockerParam] : undefined,
        query: req.query,
        body: options.sendBody ? (req.body.body || req.body) : undefined
      });
      return res.status(options.accepted ? 202 : 200).json({ success: true, requestId: result.requestId, data: result.data });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ success: false, error: error.message, details: error.details });
    }
  };
}

exports.listRemoteSubscriptionRequests = remoteSubscriptionHandler('LIST_SUBSCRIPTION_REQUESTS');
exports.getRemoteSubscriptionRequest = remoteSubscriptionHandler('GET_SUBSCRIPTION_REQUEST', { resourceParam: 'subscriptionRequestId' });
exports.getRemoteSubscription = remoteSubscriptionHandler('GET_SUBSCRIPTION', { resourceParam: 'subscriptionId' });
exports.editSubscription = remoteSubscriptionHandler('EDIT_SUBSCRIPTION', { resourceParam: 'subscriptionId', sendBody: true, accepted: true });
exports.disableSubscription = remoteSubscriptionHandler('DISABLE_SUBSCRIPTION', { resourceParam: 'subscriptionId', accepted: true });
exports.enableSubscription = remoteSubscriptionHandler('ENABLE_SUBSCRIPTION', { resourceParam: 'subscriptionId', accepted: true });
exports.patientSubscriptionRequests = remoteSubscriptionHandler('PATIENT_SUBSCRIPTION_REQUESTS');
exports.setupHealthLocker = remoteSubscriptionHandler('SETUP_HEALTH_LOCKER', { sendBody: true, accepted: true });
exports.listPatientLockers = remoteSubscriptionHandler('LIST_PATIENT_LOCKERS');
exports.getPatientLocker = remoteSubscriptionHandler('GET_PATIENT_LOCKER', { lockerParam: 'lockerId' });

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
