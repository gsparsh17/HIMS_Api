const Patient = require('../models/Patient');
const AbdmCareContext = require('../models/AbdmCareContext');
const AbdmDataTransfer = require('../models/AbdmDataTransfer');
const AbdmHospitalJob = require('../models/AbdmHospitalJob');
const abdmConfig = require('../config/abdm.config');
const {
  buildPatientCareContexts,
  groupedForAbdm
} = require('../services/abdmCareContext.service');
const { generateAbdmHiBundle } = require('../services/fhir/abdmHiBundle.service');
const { masterRequest } = require('../services/abdmMasterClient.service');
const { validateBundle } = require('../services/abdmFhirValidation.service');
const { toAbdmHiType } = require('../utils/abdmHiTypes');
const {
  assertUserHospital,
  assertSameHospital
} = require('../utils/hospitalScope');
const { assertAbdmExchangeEligible } = require('../services/abdmExchangeEligibility.service');
const { withPatientAccessToken } = require('../services/abdmCredential.service');

function abdmGender(value) {
  const gender = String(value || '').toLowerCase();
  if (gender === 'male') return 'M';
  if (gender === 'female') return 'F';
  return 'O';
}

async function scopedPatient(patientId, user) {
  const patient = await Patient.findById(patientId);
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }
  assertSameHospital(patient.hospitalId, user);
  return patient;
}

exports.integrationStatus = async (_req, res) => {
  const configured = Boolean(
    abdmConfig.masterUrl &&
      abdmConfig.hipId &&
      abdmConfig.connectorKeyId &&
      abdmConfig.connectorSecret
  );

  let master = null;
  let masterError = null;
  if (configured) {
    try {
      master = await masterRequest('/internal/abdm/facility-status', {
        method: 'GET'
      });
    } catch (error) {
      masterError = error.message;
    }
  }

  return res.json({
    success: true,
    configured,
    appRole: abdmConfig.appRole,
    environment: abdmConfig.environment,
    hfrFacilityId: abdmConfig.hfrFacilityId || null,
    hipId: abdmConfig.hipId || null,
    hiuId: abdmConfig.hiuId || null,
    tenantCode: abdmConfig.tenantCode || null,
    masterUrl: abdmConfig.masterUrl || null,
    masterConnected: Boolean(master?.success),
    masterReachable: Boolean(master?.success),
    masterError,
    centralStatus: master?.facility || null,
    features: {
      m1: abdmConfig.featureM1,
      m2: abdmConfig.featureM2,
      m3: abdmConfig.featureM3,
      subscriptions: abdmConfig.featureSubscriptions
    },
    transferReadiness: {
      cryptoMode: abdmConfig.cryptoMode,
      cryptoAdapterConfigured: Boolean(abdmConfig.cryptoAdapterUrl),
      fhirValidatorConfigured: Boolean(abdmConfig.fhirValidatorUrl),
      dataPushAllowlistConfigured: abdmConfig.dataPushAllowedHosts.length > 0
    }
  });
};

exports.buildCareContexts = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    const contexts = await buildPatientCareContexts(patient._id);
    return res.json({ success: true, count: contexts.length, contexts });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json({ success: false, error: error.message });
  }
};

exports.listPatientCareContexts = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    const contexts = await AbdmCareContext.find({
      hospitalId: patient.hospitalId,
      patientId: patient._id,
      active: { $ne: false }
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, count: contexts.length, contexts });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json({ success: false, error: error.message });
  }
};

exports.groupedCareContexts = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    const result = await groupedForAbdm(patient._id);
    return res.json({ success: true, patient: result.patientGroups });
  } catch (error) {
    return res
      .status(error.statusCode || 404)
      .json({ success: false, error: error.message });
  }
};

exports.initiateHipLinking = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    assertAbdmExchangeEligible(patient);

    await buildPatientCareContexts(patient._id);
    const query = {
      hospitalId: patient.hospitalId,
      patientId: patient._id,
      linkStatus: { $in: ['LOCAL_RECORD_READY', 'ABDM_LINK_FAILED'] }
    };
    if (Array.isArray(req.body?.careContextIds) && req.body.careContextIds.length) {
      query._id = { $in: req.body.careContextIds };
    }

    const contexts = await AbdmCareContext.find(query);
    if (!contexts.length) {
      return res.status(409).json({
        success: false,
        error: 'No unlinked local care contexts are available for this patient'
      });
    }

    const body = {
      ...(patient.abha?.number ? { abhaNumber: patient.abha.number } : {}),
      ...(patient.abha?.address ? { abhaAddress: patient.abha.address } : {}),
      name: [patient.first_name, patient.middle_name, patient.last_name]
        .filter(Boolean)
        .join(' '),
      gender: abdmGender(patient.gender),
      yearOfBirth: new Date(patient.dob).getFullYear()
    };

    const result = await masterRequest('/internal/abdm/m2/action', {
      method: 'POST',
      body: { action: 'GENERATE_LINK_TOKEN', body }
    });

    await AbdmCareContext.updateMany(
      {
        hospitalId: patient.hospitalId,
        _id: { $in: contexts.map((item) => item._id) }
      },
      {
        linkStatus: 'ABDM_LINK_PENDING',
        linkRequestId: result.requestId,
        metadata: {
          initiatedBy: req.user?._id,
          initiatedAt: new Date(),
          masterRequestId: result.requestId
        }
      }
    );

    return res.status(202).json({
      success: true,
      requestId: result.requestId,
      pendingCareContexts: contexts.length,
      message:
        'ABDM link-token generation was accepted. Final linking continues asynchronously through the ABDM callback.'
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.notifyCareContextUpdate = async (req, res) => {
  try {
    const hospitalId = assertUserHospital(req.user);
    const context = await AbdmCareContext.findOne({
      _id: req.params.contextId,
      hospitalId
    });
    if (!context || context.active === false) {
      return res
        .status(404)
        .json({ success: false, error: 'Care context not found' });
    }
    if (context.linkStatus !== 'ABDM_LINKED') {
      return res.status(409).json({
        success: false,
        error: 'Only ABDM-linked care contexts can be notified as updated'
      });
    }

    const patient = await Patient.findOne({
      _id: context.patientId,
      hospitalId
    });
    if (!patient) throw new Error('Patient not found');
    assertAbdmExchangeEligible(patient);

    const body = {
      notification: {
        patient: { id: patient.abha.address },
        careContext: {
          patientReference: context.patientReference,
          careContextReference: context.referenceNumber,
          hiType: toAbdmHiType(context.hiType),
          display: context.display
        },
        date: new Date().toISOString()
      }
    };

    const result = await masterRequest('/internal/abdm/m2/action', {
      method: 'POST',
      body: { action: 'NOTIFY_CARE_CONTEXT_UPDATE', body }
    });
    context.lastNotifiedAt = new Date();
    context.metadata = {
      ...(context.metadata || {}),
      lastUpdateNotificationRequestId: result.requestId
    };
    await context.save();
    return res.status(202).json({ success: true, requestId: result.requestId });
  } catch (error) {
    return res.status(error.statusCode || 502).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.generateFhir = async (req, res) => {
  try {
    const { patientId, hiTypes, dateRange } = req.body || {};
    if (!patientId) {
      return res
        .status(400)
        .json({ success: false, error: 'patientId is required' });
    }
    const patient = await scopedPatient(patientId, req.user);
    assertAbdmExchangeEligible(patient);
    const result = await generateAbdmHiBundle(patient._id, {
      hiTypes,
      dateRange,
      createdBy: req.user?._id,
      hospitalId: patient.hospitalId
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json({ success: false, error: error.message });
  }
};

exports.validateFhir = async (req, res) => {
  try {
    const result = await validateBundle(req.body.bundle, {
      external: req.body.external !== false
    });
    return res
      .status(result.valid ? 200 : 422)
      .json({ success: result.valid, validation: result });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
};

exports.listTransfers = async (req, res) => {
  const filter = { hospitalId: assertUserHospital(req.user) };
  if (req.query.direction) filter.direction = req.query.direction;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.patientId) filter.patientId = req.query.patientId;
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
  const transfers = await AbdmDataTransfer.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return res.json({ success: true, count: transfers.length, transfers });
};

exports.listJobs = async (req, res) => {
  const filter = { hospitalId: assertUserHospital(req.user) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
  const jobs = await AbdmHospitalJob.find(filter)
    .select('-payload')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return res.json({ success: true, count: jobs.length, jobs });
};


exports.sendHipLinkSms = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    assertAbdmExchangeEligible(patient);
    const result = await masterRequest('/internal/abdm/m2/action', {
      method: 'POST',
      body: {
        action: 'SEND_LINK_SMS',
        body: {
          notification: {
            phoneNo: String(patient.phone || '').replace(/\D/g, ''),
            hip: { id: abdmConfig.hipId, name: req.body.hipName || 'Hospital' }
          }
        }
      }
    });
    return res.status(202).json({ success: true, requestId: result.requestId });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.requestRunningTokenStatus = async (req, res) => {
  try {
    const patient = await scopedPatient(req.params.patientId, req.user);
    assertAbdmExchangeEligible(patient);
    const result = await withPatientAccessToken(patient._id, (token) =>
      masterRequest('/internal/abdm/m3/action', {
        method: 'POST',
        body: {
          action: 'REQUEST_RUNNING_TOKEN_STATUS',
          authToken: token,
          body: { hipId: abdmConfig.hipId, context: String(req.body.context || '1') }
        }
      }), { updatedBy: req.user._id }
    );
    return res.status(202).json({ success: true, requestId: result.requestId });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, code: error.code, error: error.message, details: error.details });
  }
};

exports.retryJob = async (req, res) => {
  const job = await AbdmHospitalJob.findOne({
    _id: req.params.jobId,
    hospitalId: assertUserHospital(req.user)
  }).select('+payload');
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  if (!['FAILED', 'DEAD', 'PENDING'].includes(job.status)) {
    return res
      .status(409)
      .json({ success: false, error: `Job is ${job.status}` });
  }
  if (!job.payload) {
    return res.status(409).json({
      success: false,
      error: 'Job payload has already been purged and cannot be retried'
    });
  }
  job.status = 'PENDING';
  job.runAfter = new Date();
  job.lockedAt = null;
  job.completedAt = null;
  job.lastError = undefined;
  await job.save();
  return res.json({ success: true, job });
};
