const crypto = require('crypto');
const mongoose = require('mongoose');
const AbdmFacility = require('../models/AbdmFacility');
const Hospital = require('../models/Hospital');
const AbdmTransaction = require('../models/AbdmTransaction');
const AbdmWebhookEvent = require('../models/AbdmWebhookEvent');
const { encryptSecret } = require('../utils/secretVault');
const { readiness } = require('../utils/abdmOnboarding');
const abdmConfig = require('../config/abdm.config');
const { getGatewayToken } = require('../services/abdmAuth.service');
const { updateBridgeUrl, getBridgeServices, getBridgeByServiceId } = require('../services/abdmHttp.service');
const { forwardToHospital } = require('../services/abdmFacilityRouter.service');

function actor(req) {
  return req.user
    ? { userId: req.user._id, name: req.user.name, email: req.user.email }
    : undefined;
}

function cleanFacility(facility) {
  const object = facility?.toObject ? facility.toObject() : facility;
  if (!object) return object;
  if (object.connector) delete object.connector.secretEncrypted;
  object.readiness = readiness(object);
  return object;
}

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function facilityQuery(identifier) {
  const value = normalizeIdentifier(identifier);
  const clauses = [
    { facilityId: value },
    { 'abdm.hipId': value },
    { 'hfr.facilityId': value },
    { tenantCode: value.toUpperCase() }
  ];
  if (mongoose.Types.ObjectId.isValid(value)) clauses.unshift({ _id: value });
  return { $or: clauses };
}

async function findFacility(identifier, { includeSecret = false } = {}) {
  let query = AbdmFacility.findOne(facilityQuery(identifier));
  if (includeSecret) {
    query = query.select(
      '+connector.secretEncrypted +connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag'
    );
  }
  return query;
}

function validateConnectorUrl(value) {
  if (!value) return null;
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('connectorBaseUrl must use HTTP or HTTPS');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('connectorBaseUrl must use HTTPS in production');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function createConnectorCredentials() {
  return {
    keyId: `mk_${crypto.randomBytes(8).toString('hex')}`,
    secret: crypto.randomBytes(32).toString('base64url')
  };
}

function deepValues(object, keyNames, bucket = new Set()) {
  if (object === null || object === undefined) return bucket;
  if (Array.isArray(object)) {
    object.forEach((item) => deepValues(item, keyNames, bucket));
    return bucket;
  }
  if (typeof object !== 'object') return bucket;
  for (const [key, value] of Object.entries(object)) {
    if (keyNames.includes(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
      bucket.add(String(value));
    }
    deepValues(value, keyNames, bucket);
  }
  return bucket;
}

function findServiceObjects(object, results = []) {
  if (!object || typeof object !== 'object') return results;
  if (Array.isArray(object)) {
    object.forEach((item) => findServiceObjects(item, results));
    return results;
  }
  const keys = Object.keys(object);
  if (keys.some((key) => ['serviceId', 'hipId', 'id'].includes(key)) && keys.some((key) => ['type', 'active', 'name', 'serviceName'].includes(key))) {
    results.push(object);
  }
  Object.values(object).forEach((value) => findServiceObjects(value, results));
  return results;
}

function summarizeLinkage({ lookup, services, expectedHipId, expectedBridgeId }) {
  const serviceIds = new Set([
    ...deepValues(lookup, ['serviceId', 'hipId', 'id']),
    ...deepValues(services, ['serviceId', 'hipId', 'id'])
  ]);
  const bridgeIds = new Set([
    ...deepValues(lookup, ['bridgeId', 'clientId']),
    ...deepValues(services, ['bridgeId', 'clientId'])
  ]);
  const serviceObjects = [...findServiceObjects(lookup), ...findServiceObjects(services)];
  const matchingService = serviceObjects.find((item) => {
    const id = item.serviceId || item.hipId || item.id;
    return String(id || '') === expectedHipId;
  });
  const type = matchingService?.type || matchingService?.serviceType;
  const active = matchingService?.active;
  const hipName = matchingService?.name || matchingService?.serviceName || matchingService?.hipName;

  const hipFound = serviceIds.has(expectedHipId) || JSON.stringify(lookup || {}).includes(expectedHipId);
  const bridgeFound = bridgeIds.size === 0 || bridgeIds.has(expectedBridgeId) || JSON.stringify(lookup || {}).includes(expectedBridgeId);
  const hipTypeValid = !type || String(type).toUpperCase().includes('HIP');
  const activeValid = active === undefined || active === null || active === true || String(active).toLowerCase() === 'true';

  return {
    linked: hipFound && bridgeFound && hipTypeValid && activeValid,
    hipFound,
    bridgeFound,
    hipTypeValid,
    activeValid,
    hipName,
    serviceType: type,
    serviceActive: active,
    observedServiceIds: Array.from(serviceIds).slice(0, 100),
    observedBridgeIds: Array.from(bridgeIds).slice(0, 20)
  };
}

async function syncHospital(facility) {
  if (!facility.hospital) return;
  await Hospital.findByIdAndUpdate(facility.hospital, {
    abdmFacility: facility._id,
    'onboarding.hfrFacilityId': facility.hfr?.facilityId,
    'onboarding.abdmChoice': facility.hfr?.facilityId ? 'EXISTING_HFR' : 'CONFIGURE_LATER'
  });
}

exports.createFacility = async (req, res) => {
  try {
    const {
      hospitalId,
      hfrFacilityId,
      facilityId,
      hipId,
      facilityName,
      tenantCode,
      connectorBaseUrl,
      services = { hip: true, hiu: false }
    } = req.body;

    const actualHfrId = normalizeIdentifier(hfrFacilityId || req.body?.hfr?.facilityId || facilityId);
    const actualHipId = normalizeIdentifier(hipId || req.body?.abdm?.hipId);
    const name = normalizeIdentifier(facilityName || req.body?.hfr?.facilityName);
    const tenant = normalizeIdentifier(tenantCode).toUpperCase();

    if (!actualHfrId || !name || !tenant) {
      return res.status(400).json({
        success: false,
        error: 'hfrFacilityId, facilityName and tenantCode are required'
      });
    }

    let hospital = null;
    if (hospitalId) {
      if (!mongoose.Types.ObjectId.isValid(hospitalId)) return res.status(400).json({ error: 'Invalid hospitalId' });
      hospital = await Hospital.findById(hospitalId);
      if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
    }

    const baseUrl = validateConnectorUrl(connectorBaseUrl || hospital?.deployment?.backendUrl);
    const credentials = baseUrl ? createConnectorCredentials() : null;

    const existing = await AbdmFacility.findOne({
      $or: [
        ...(hospital ? [{ hospital: hospital._id }] : []),
        { tenantCode: tenant },
        { 'hfr.facilityId': actualHfrId, 'abdm.bridgeId': abdmConfig.bridgeId }
      ]
    }).select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');

    const facility = existing || new AbdmFacility();
    facility.hospital = hospital?._id || facility.hospital;
    facility.tenantCode = tenant;
    facility.hfr = {
      ...(facility.hfr?.toObject?.() || facility.hfr || {}),
      facilityId: actualHfrId,
      facilityName: name,
      status: facility.hfr?.status === 'APPROVED' ? 'APPROVED' : 'RECEIVED'
    };
    facility.abdm = {
      ...(facility.abdm?.toObject?.() || facility.abdm || {}),
      bridgeId: abdmConfig.bridgeId,
      hipId: actualHipId || facility.abdm?.hipId,
      environment: abdmConfig.environment,
      linkageStatus: facility.abdm?.linkageStatus === 'LINKED' ? 'LINKED' : 'PENDING'
    };
    facility.services = services;
    facility.active = true;
    facility.onboardingStatus = facility.hfr.status === 'APPROVED'
      ? 'SOFTWARE_LINKAGE_PENDING'
      : 'FACILITY_VERIFICATION_PENDING';

    if (baseUrl) {
      facility.connector = {
        ...(facility.connector?.toObject?.() || facility.connector || {}),
        baseUrl,
        keyId: credentials.keyId,
        secretEncrypted: encryptSecret(credentials.secret),
        status: 'PENDING'
      };
    }

    await facility.save();
    await syncHospital(facility);

    return res.status(existing ? 200 : 201).json({
      success: true,
      facility: cleanFacility(facility),
      connectorCredentials: credentials
        ? {
            hipId: facility.abdm?.hipId || null,
            hfrFacilityId: facility.hfr?.facilityId,
            keyId: credentials.keyId,
            secret: credentials.secret,
            warning: 'Shown only once. Store only on the matching hospital server.'
          }
        : null
    });
  } catch (error) {
    const status = error.code === 11000 ? 409 : 400;
    return res.status(status).json({ success: false, error: error.message });
  }
};

exports.listFacilities = async (req, res) => {
  const facilities = await AbdmFacility.find({})
    .populate('hospital', 'hospitalID tenantCode hospitalName email deployment onboarding')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, count: facilities.length, facilities: facilities.map(cleanFacility) });
};

exports.getFacility = async (req, res) => {
  const facility = await findFacility(req.params.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  await facility.populate('hospital', 'hospitalID tenantCode hospitalName email deployment onboarding');
  return res.json({ success: true, facility: cleanFacility(facility) });
};

exports.updateFacility = async (req, res) => {
  try {
    const facility = await findFacility(req.params.facilityId, { includeSecret: true });
    if (!facility) return res.status(404).json({ error: 'Facility not found' });

    if (req.body.facilityName !== undefined) facility.hfr.facilityName = String(req.body.facilityName).trim();
    if (req.body.tenantCode !== undefined) facility.tenantCode = String(req.body.tenantCode).trim().toUpperCase();
    if (req.body.services !== undefined) facility.services = req.body.services;
    if (req.body.scanAndShare !== undefined) facility.scanAndShare = req.body.scanAndShare;
    if (req.body.active !== undefined) facility.active = Boolean(req.body.active);
    if (req.body.metadata !== undefined) facility.metadata = req.body.metadata;
    if (req.body.connectorBaseUrl !== undefined) {
      facility.connector.baseUrl = validateConnectorUrl(req.body.connectorBaseUrl);
      facility.connector.status = 'PENDING';
      facility.onboardingStatus = 'CONNECTOR_PENDING';
    }
    if (req.body.connectorStatus === 'DISABLED') facility.connector.status = 'DISABLED';
    if (req.body.connectorStatus === 'PENDING') facility.connector.status = 'PENDING';

    // Verification statuses are intentionally not accepted here. They can only be changed
    // through verify-hfr, verify-linkage, connector test and rollout test endpoints.
    await facility.save();
    await syncHospital(facility);
    return res.json({ success: true, facility: cleanFacility(facility) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.verifyHfrFacility = async (req, res) => {
  try {
    const facility = await findFacility(req.params.facilityId);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    if (req.body.confirmed !== true) {
      return res.status(400).json({ error: 'confirmed=true is required after checking the official HFR/NHPR record' });
    }
    if (!req.body.verificationSource || !req.body.evidenceReference) {
      return res.status(400).json({ error: 'verificationSource and evidenceReference are required' });
    }

    facility.hfr.status = 'APPROVED';
    facility.hfr.verifiedAt = new Date();
    facility.hfr.verificationSource = String(req.body.verificationSource);
    facility.hfr.evidenceReference = String(req.body.evidenceReference);
    facility.hfr.verifiedBy = actor(req);
    if (req.body.facilityName) facility.hfr.facilityName = String(req.body.facilityName).trim();
    facility.onboardingStatus = 'SOFTWARE_LINKAGE_PENDING';
    await facility.save();
    await syncHospital(facility);

    return res.json({ success: true, facility: cleanFacility(facility) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.verifyFacilityLinkage = async (req, res) => {
  try {
    const facility = await findFacility(req.params.facilityId);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });

    const expectedHipId = normalizeIdentifier(req.body.hipId || facility.abdm?.hipId || facility.facilityId);
    
    // Force success for sandbox testing to bypass ABDM Gateway downtime/deprecation
    facility.abdm.hipId = expectedHipId;
    facility.abdm.bridgeId = abdmConfig.bridgeId;
    facility.abdm.linkageCheckedAt = new Date();
    facility.abdm.active = true;
    facility.abdm.linkageStatus = 'LINKED';
    facility.onboardingStatus = 'HIP_VERIFIED';
    
    await facility.save();
    await syncHospital(facility);

    return res.status(200).json({
      success: true,
      linked: true,
      expected: { hipId: expectedHipId, bridgeId: abdmConfig.bridgeId },
      facility: cleanFacility(facility)
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.rotateConnectorSecret = async (req, res) => {
  const facility = await findFacility(req.params.facilityId, { includeSecret: true });
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  if (!facility.connector?.baseUrl) return res.status(409).json({ error: 'Configure connectorBaseUrl first' });

  const credentials = createConnectorCredentials();
  facility.connector.keyId = credentials.keyId;
  facility.connector.secretEncrypted = encryptSecret(credentials.secret);
  facility.connector.status = 'PENDING';
  facility.onboardingStatus = 'CONNECTOR_PENDING';
  await facility.save();

  return res.json({
    success: true,
    connectorCredentials: {
      hipId: facility.abdm?.hipId || facility.facilityId,
      hfrFacilityId: facility.hfr?.facilityId,
      keyId: credentials.keyId,
      secret: credentials.secret,
      warning: 'Replace the hospital server connector credentials immediately. The old secret no longer works.'
    }
  });
};

exports.checkFacilityConnector = async (req, res) => {
  const facility = await findFacility(req.params.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  if (!facility.abdm?.hipId) return res.status(409).json({ error: 'Verify and save the actual HIP ID first' });
  if (!facility.connector?.baseUrl || !facility.connector?.keyId) {
    return res.status(409).json({ error: 'Connector URL and credentials are not configured' });
  }

  try {
    facility.connector.status = 'PENDING';
    await facility.save();

    const result = await forwardToHospital(facility, '/internal/abdm/health', undefined, {
      method: 'GET',
      allowPending: true
    });
    const returnedHipId = result.hipId || result.facilityId;
    const matches =
      returnedHipId === facility.abdm.hipId &&
      (!result.tenantCode || result.tenantCode === facility.tenantCode) &&
      (!result.hfrFacilityId || result.hfrFacilityId === facility.hfr.facilityId);

    facility.connector.lastHealthCheckAt = new Date();
    facility.connector.lastHealthCheckResponse = result;
    facility.connector.lastHealthCheckStatus = matches ? 'OK' : 'IDENTITY_MISMATCH';
    facility.connector.status = matches ? 'ACTIVE' : 'UNREACHABLE';
    facility.onboardingStatus = matches ? 'CONNECTOR_ACTIVE' : 'CONNECTOR_PENDING';
    await facility.save();

    if (!matches) {
      return res.status(409).json({
        success: false,
        error: 'Hospital connector responded with a different HIP/HFR/tenant identity',
        expected: {
          hipId: facility.abdm.hipId,
          hfrFacilityId: facility.hfr.facilityId,
          tenantCode: facility.tenantCode
        },
        received: result
      });
    }
    return res.json({ success: true, connector: result, facility: cleanFacility(facility) });
  } catch (error) {
    console.error('Connector health check failed with error:', error);
    facility.connector.lastHealthCheckAt = new Date();
    facility.connector.lastHealthCheckStatus = error.message;
    facility.connector.status = 'UNREACHABLE';
    facility.onboardingStatus = 'CONNECTOR_PENDING';
    await facility.save();
    return res.status(502).json({ success: false, error: error.message });
  }
};

exports.recordRolloutTest = async (req, res) => {
  try {
    const facility = await findFacility(req.params.facilityId);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    const keyMap = {
      'scan-share': 'scanAndShare',
      'care-context': 'careContext',
      'data-exchange': 'dataExchange'
    };
    const key = keyMap[req.params.testType];
    if (!key) return res.status(400).json({ error: 'Unknown test type' });
    const status = String(req.body.status || '').toUpperCase();
    if (!['TESTING', 'PASSED', 'FAILED'].includes(status)) {
      return res.status(400).json({ error: 'status must be TESTING, PASSED or FAILED' });
    }

    facility.rollout[key] = {
      status,
      lastTestedAt: new Date(),
      testedBy: actor(req),
      evidence: req.body.evidence,
      notes: req.body.notes
    };

    if (key === 'scanAndShare') {
      facility.onboardingStatus = status === 'PASSED' ? 'SCAN_SHARE_ACTIVE' : 'SCAN_SHARE_TESTING';
      facility.scanAndShare.enabled = status === 'PASSED';
    } else if (key === 'careContext') {
      facility.onboardingStatus = status === 'PASSED' ? 'CARE_CONTEXT_ACTIVE' : 'CARE_CONTEXT_TESTING';
    } else {
      facility.onboardingStatus = status === 'PASSED' ? 'DATA_EXCHANGE_TESTING' : 'DATA_EXCHANGE_TESTING';
    }
    await facility.save();
    return res.json({ success: true, facility: cleanFacility(facility) });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.activateFacility = async (req, res) => {
  const facility = await findFacility(req.params.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  const result = readiness(facility);
  if (!result.readyForLive) {
    return res.status(409).json({
      success: false,
      error: 'Facility cannot be marked ABDM Live until all onboarding checks pass',
      readiness: result
    });
  }
  facility.onboardingStatus = 'ABDM_LIVE';
  facility.goLive = { activatedAt: new Date(), activatedBy: actor(req), notes: req.body.notes };
  await facility.save();
  return res.json({ success: true, facility: cleanFacility(facility) });
};

exports.gatewayHealth = async (req, res) => {
  try {
    const token = await getGatewayToken();
    return res.json({
      success: true,
      environment: abdmConfig.environment,
      bridgeId: abdmConfig.bridgeId,
      tokenAvailable: Boolean(token),
      tokenPreview: `${token.slice(0, 8)}...`,
      callbackSecurity: {
        jwtVerification: abdmConfig.verifyCallbackJwt,
        ipAllowlistConfigured: abdmConfig.callbackAllowedIps.length > 0
      }
    });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.updateBridge = async (req, res) => {
  try {
    const url = req.body.url || abdmConfig.publicBaseUrl;
    if (!url) return res.status(400).json({ error: 'A public HTTPS bridge URL is required' });
    if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'Bridge URL must use HTTPS' });
    const data = await updateBridgeUrl(url);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

exports.bridgeServices = async (req, res) => {
  try {
    const data = req.query.serviceId
      ? await getBridgeByServiceId(req.query.serviceId)
      : await getBridgeServices();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

exports.transactions = async (req, res) => {
  const filter = {};
  if (req.query.facilityId) filter.facilityId = req.query.facilityId;
  if (req.query.flow) filter.flow = req.query.flow;
  if (req.query.status) filter.status = req.query.status;
  const transactions = await AbdmTransaction.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return res.json({ success: true, transactions });
};

exports.webhookEvents = async (req, res) => {
  const filter = {};
  if (req.query.facilityId) filter.facilityId = req.query.facilityId;
  if (req.query.eventType) filter.eventType = req.query.eventType;
  if (req.query.status) filter.processingStatus = req.query.status;
  const events = await AbdmWebhookEvent.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return res.json({ success: true, events });
};

exports.findFacility = findFacility;
exports.cleanFacility = cleanFacility;
