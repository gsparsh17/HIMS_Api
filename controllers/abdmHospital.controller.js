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
const {
  validateBundle,
  checkFhirValidatorHealth
} = require('../services/abdmFhirValidation.service');
const { checkCryptoAdapterHealth } = require('../services/abdmCryptoAdapter.service');
const { checkConsentValidatorHealth } = require('../services/abdmConsentValidation.service');
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

function abdmLinkingIdentity(patient) {
  const digits = String(patient?.abha?.number || '').replace(/\D/g, '');
  if (digits.length !== 14) {
    const error = new Error(
      'A valid 14-digit ABHA number is required for HIP care-context linking'
    );
    error.statusCode = 400;
    throw error;
  }

  const dob = patient?.dob ? new Date(patient.dob) : null;
  const yearOfBirth =
    dob && !Number.isNaN(dob.getTime()) ? dob.getUTCFullYear() : NaN;
  if (!Number.isInteger(yearOfBirth)) {
    const error = new Error(
      'A valid patient date of birth is required for HIP care-context linking'
    );
    error.statusCode = 400;
    throw error;
  }

  const name = [
    patient?.first_name,
    patient?.middle_name,
    patient?.last_name
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!name) {
    const error = new Error(
      'Patient name is required for HIP care-context linking'
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    // The official ABDM M2 request expects the 14-digit ABHA number as JSON number.
    abhaNumber: Number(digits),
    ...(patient?.abha?.address
      ? {
          abhaAddress: String(patient.abha.address)
            .trim()
            .toLowerCase()
        }
      : {}),
    name,
    gender: abdmGender(patient?.gender),
    yearOfBirth
  };
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


function patientAuthTokenMetadata(token) {
  const raw = String(token || '')
    .replace(/^Bearer\s+/i, '')
    .trim();

  try {
    const parts = raw.split('.');
    if (parts.length !== 3) return { raw, jwt: false };

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );

    return {
      raw,
      jwt: true,
      clientId: payload.clientId || payload.client_id || null,
      system: payload.system || null,
      type: payload.typ || null,
      expiresAt: payload.exp
        ? new Date(Number(payload.exp) * 1000)
        : null
    };
  } catch (_error) {
    return { raw, jwt: false };
  }
}

function requireHiecmPatientAuthToken(token) {
  const metadata = patientAuthTokenMetadata(token);

  if (!metadata.raw || !metadata.jwt) {
    const error = new Error(
      'A valid ABDM PHR/HIE-CM patient authentication JWT is required'
    );
    error.statusCode = 401;
    error.code = 'ABDM_PHR_AUTH_REQUIRED';
    throw error;
  }

  const clientId = String(metadata.clientId || '').toLowerCase();
  const system = String(metadata.system || '').toUpperCase();

  // Tokens issued for the M1 ABHA profile API are not valid as HIE-CM
  // X-AUTH-TOKEN values. The existing ABHA-address login OTP flow issues
  // the PHR-WEB/ABDM patient token required for running-token operations.
  if (clientId === 'abha-profile-app-api' || system === 'ABHA-N') {
    const error = new Error(
      'The stored token is an M1 ABHA profile token. Complete ABHA Address/PHR login by OTP before requesting running-token status.'
    );
    error.statusCode = 409;
    error.code = 'ABDM_PHR_AUTH_REQUIRED';
    error.details = {
      requiredFlow: 'ABHA_ADDRESS_LOGIN',
      endpoints: [
        '/api/abha/login/address/search',
        '/api/abha/login/address/request-otp',
        '/api/abha/login/address/verify-otp'
      ]
    };
    throw error;
  }

  if (
    metadata.expiresAt &&
    !Number.isNaN(metadata.expiresAt.getTime()) &&
    metadata.expiresAt.getTime() <= Date.now()
  ) {
    const error = new Error(
      'The ABDM PHR/HIE-CM patient authentication token has expired'
    );
    error.statusCode = 401;
    error.code = 'ABDM_PHR_AUTH_REQUIRED';
    error.details = {
      reason: 'PHR_TOKEN_EXPIRED',
      requiredFlow: 'ABHA_ADDRESS_LOGIN'
    };
    throw error;
  }

  return metadata.raw;
}

exports.integrationStatus = async (_req, res) => {
  const configured = Boolean(
    abdmConfig.masterUrl &&
      abdmConfig.hipId &&
      abdmConfig.hiuId &&
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
      masterError = error.code || 'MASTER_UNREACHABLE';
    }
  }

  const [fhirValidator, cryptoAdapter, consentValidator] = await Promise.all([
    checkFhirValidatorHealth(),
    checkCryptoAdapterHealth(),
    checkConsentValidatorHealth()
  ]);

  const transferReadiness = {
    cryptoMode: abdmConfig.cryptoMode,
    cryptoAdapterConfigured: Boolean(abdmConfig.cryptoAdapterUrl),
    cryptoAdapterHealthy: cryptoAdapter.healthy === true,
    cryptoIntegrityRequired: abdmConfig.requireCryptoIntegrity === true,
    fhirValidatorConfigured: Boolean(abdmConfig.fhirValidatorUrl),
    fhirValidatorHealthy: fhirValidator.healthy === true,
    externalFhirValidationRequired: abdmConfig.requireExternalFhirValidation === true,
    fhirPackage: abdmConfig.fhirPackage,
    fhirVersion: abdmConfig.fhirR4Version,
    consentValidatorConfigured: Boolean(abdmConfig.consentValidatorUrl),
    consentValidatorHealthy: consentValidator.healthy === true,
    consentValidatorProductionCapable: consentValidator.productionCapable === true,
    consentValidationRequired: abdmConfig.requireConsentValidation === true,
    dataPushAllowlistConfigured: abdmConfig.dataPushAllowedHosts.length > 0,
    privateDataPushAllowed: abdmConfig.allowPrivateDataPushUrls === true
  };
  const packetReadiness = {
    enabled: abdmConfig.packetFeatureEnabled,
    reviewPolicy: abdmConfig.packetDefaultReviewPolicy,
    immutableVersions: true,
    encryptedBundleStorage: abdmConfig.packetStorePlaintext !== true,
    sourceSnapshotBinding: true,
    consentScopeBinding: true,
    approvalRequiredBeforeTransfer:
      abdmConfig.packetDefaultReviewPolicy !== 'PREVIEW_ONLY'
  };
  const productionTransferReady = Boolean(
    configured &&
      abdmConfig.cryptoMode === 'external' &&
      transferReadiness.cryptoAdapterConfigured &&
      transferReadiness.cryptoAdapterHealthy &&
      transferReadiness.cryptoIntegrityRequired &&
      transferReadiness.fhirValidatorConfigured &&
      transferReadiness.fhirValidatorHealthy &&
      transferReadiness.externalFhirValidationRequired &&
      transferReadiness.consentValidatorConfigured &&
      transferReadiness.consentValidatorHealthy &&
      transferReadiness.consentValidatorProductionCapable &&
      transferReadiness.consentValidationRequired &&
      transferReadiness.dataPushAllowlistConfigured &&
      !transferReadiness.privateDataPushAllowed &&
      packetReadiness.enabled &&
      packetReadiness.approvalRequiredBeforeTransfer
  );

  const dependencyStatus = {
    reportedAt: new Date().toISOString(),
    productionTransferReady,
    transferReadiness,
    packetReadiness,
    dependencies: { fhirValidator, cryptoAdapter, consentValidator }
  };
  if (configured) {
    masterRequest('/internal/abdm/dependency-status', {
      method: 'POST',
      body: dependencyStatus
    }).catch(() => {});
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
    masterConnected: Boolean(master?.success),
    masterReachable: Boolean(master?.success),
    masterError,
    centralStatus: master?.facility || null,
    features: {
      m1: abdmConfig.featureM1,
      m2: abdmConfig.featureM2,
      m3: abdmConfig.featureM3,
      subscriptions: abdmConfig.featureSubscriptions,
      abdmPackets: abdmConfig.packetFeatureEnabled
    },
    productionTransferReady,
    transferReadiness,
    packetReadiness,
    dependencies: dependencyStatus.dependencies
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

    const body = abdmLinkingIdentity(patient);

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
    const result = await withPatientAccessToken(
      patient._id,
      (token) => {
        const patientAuthToken = requireHiecmPatientAuthToken(token);
        return masterRequest('/internal/abdm/m3/action', {
          method: 'POST',
          body: {
            action: 'REQUEST_RUNNING_TOKEN_STATUS',
            authToken: patientAuthToken,
            body: {
              hipId: abdmConfig.hipId,
              context: String(req.body.context || '1')
            }
          }
        });
      },
      { updatedBy: req.user._id }
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
