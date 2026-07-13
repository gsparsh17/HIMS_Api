const crypto = require('crypto');
const AbdmFacility = require('../models/AbdmFacility');
const AbdmTransaction = require('../models/AbdmTransaction');
const AbdmWebhookEvent = require('../models/AbdmWebhookEvent');
const { encryptSecret } = require('../utils/secretVault');
const abdmConfig = require('../config/abdm.config');
const { getGatewayToken } = require('../services/abdmAuth.service');
const { updateBridgeUrl, getBridgeServices, getBridgeByServiceId } = require('../services/abdmHttp.service');
const { forwardToHospital } = require('../services/abdmFacilityRouter.service');

function cleanFacility(facility) {
  const object = facility.toObject ? facility.toObject() : facility;
  if (object.connector) delete object.connector.secretEncrypted;
  return object;
}

exports.createFacility = async (req, res) => {
  try {
    const {
      facilityId,
      facilityName,
      tenantCode,
      connectorBaseUrl,
      bridgeId = abdmConfig.bridgeId,
      hfrStatus = 'APPROVED',
      softwareLinkageStatus = 'PENDING',
      services = { hip: true, hiu: false }
    } = req.body;

    if (!facilityId || !facilityName || !tenantCode || !connectorBaseUrl) {
      return res.status(400).json({
        error: 'facilityId, facilityName, tenantCode and connectorBaseUrl are required'
      });
    }
    if (!/^https:\/\//i.test(connectorBaseUrl) && process.env.NODE_ENV === 'production') {
      return res.status(400).json({ error: 'connectorBaseUrl must use HTTPS in production' });
    }

    const connectorSecret = crypto.randomBytes(32).toString('base64url');
    const keyId = `mk_${crypto.randomBytes(8).toString('hex')}`;

    const facility = await AbdmFacility.findOneAndUpdate(
      { facilityId },
      {
        facilityId,
        facilityName,
        tenantCode,
        bridgeId,
        environment: abdmConfig.environment,
        connector: {
          baseUrl: String(connectorBaseUrl).replace(/\/+$/, ''),
          keyId,
          secretEncrypted: encryptSecret(connectorSecret),
          status: 'ACTIVE'
        },
        hfrStatus,
        softwareLinkageStatus,
        services,
        active: true
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
      success: true,
      facility: cleanFacility(facility),
      connectorCredentials: {
        facilityId,
        keyId,
        secret: connectorSecret,
        warning: 'The connector secret is shown only in this response. Store it in the hospital server environment securely.'
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.listFacilities = async (req, res) => {
  const facilities = await AbdmFacility.find({}).sort({ createdAt: -1 }).lean();
  res.json({ success: true, count: facilities.length, facilities });
};

exports.getFacility = async (req, res) => {
  const facility = await AbdmFacility.findOne({ facilityId: req.params.facilityId }).lean();
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  res.json({ success: true, facility });
};

exports.updateFacility = async (req, res) => {
  const allowed = [
    'facilityName',
    'tenantCode',
    'hfrStatus',
    'softwareLinkageStatus',
    'services',
    'scanAndShare',
    'active',
    'metadata'
  ];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  if (req.body.connectorBaseUrl) update['connector.baseUrl'] = String(req.body.connectorBaseUrl).replace(/\/+$/, '');
  if (req.body.connectorStatus) update['connector.status'] = req.body.connectorStatus;

  const facility = await AbdmFacility.findOneAndUpdate({ facilityId: req.params.facilityId }, update, { new: true });
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  res.json({ success: true, facility: cleanFacility(facility) });
};

exports.rotateConnectorSecret = async (req, res) => {
  const facility = await AbdmFacility.findOne({ facilityId: req.params.facilityId })
    .select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');
  if (!facility) return res.status(404).json({ error: 'Facility not found' });

  const connectorSecret = crypto.randomBytes(32).toString('base64url');
  const keyId = `mk_${crypto.randomBytes(8).toString('hex')}`;
  facility.connector.keyId = keyId;
  facility.connector.secretEncrypted = encryptSecret(connectorSecret);
  await facility.save();

  res.json({
    success: true,
    connectorCredentials: {
      facilityId: facility.facilityId,
      keyId,
      secret: connectorSecret,
      warning: 'Replace the hospital server connector credentials immediately. The old secret no longer works.'
    }
  });
};

exports.checkFacilityConnector = async (req, res) => {
  const facility = await AbdmFacility.findOne({ facilityId: req.params.facilityId });
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  try {
    const result = await forwardToHospital(facility, '/internal/abdm/health', undefined, { method: 'GET' });
    facility.connector.lastHealthCheckAt = new Date();
    facility.connector.lastHealthCheckStatus = 'OK';
    facility.connector.status = 'ACTIVE';
    await facility.save();
    res.json({ success: true, connector: result });
  } catch (error) {
    facility.connector.lastHealthCheckAt = new Date();
    facility.connector.lastHealthCheckStatus = error.message;
    facility.connector.status = 'UNREACHABLE';
    await facility.save();
    res.status(502).json({ success: false, error: error.message });
  }
};

exports.gatewayHealth = async (req, res) => {
  try {
    const token = await getGatewayToken();
    res.json({
      success: true,
      environment: abdmConfig.environment,
      bridgeId: abdmConfig.bridgeId,
      tokenAvailable: Boolean(token),
      tokenPreview: `${token.slice(0, 8)}...`
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ success: false, error: error.message, details: error.details });
  }
};

exports.updateBridge = async (req, res) => {
  try {
    const url = req.body.url || abdmConfig.publicBaseUrl;
    const data = await updateBridgeUrl(url);
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

exports.bridgeServices = async (req, res) => {
  try {
    const data = req.query.serviceId
      ? await getBridgeByServiceId(req.query.serviceId)
      : await getBridgeServices();
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message, details: error.details });
  }
};

exports.transactions = async (req, res) => {
  const filter = {};
  if (req.query.facilityId) filter.facilityId = req.query.facilityId;
  if (req.query.flow) filter.flow = req.query.flow;
  if (req.query.status) filter.status = req.query.status;
  const transactions = await AbdmTransaction.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, transactions });
};

exports.webhookEvents = async (req, res) => {
  const filter = {};
  if (req.query.facilityId) filter.facilityId = req.query.facilityId;
  if (req.query.eventType) filter.eventType = req.query.eventType;
  if (req.query.status) filter.processingStatus = req.query.status;
  const events = await AbdmWebhookEvent.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, events });
};
