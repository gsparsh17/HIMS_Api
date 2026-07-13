const mongoose = require('mongoose');
const AbdmFacility = require('../models/AbdmFacility');
const AbdmTransaction = require('../models/AbdmTransaction');
const AbdmWebhookEvent = require('../models/AbdmWebhookEvent');
const AbdmJob = require('../models/AbdmJob');
const AbdmConsent = require('../models/AbdmConsent');
const abdmConfig = require('../config/abdm.config');

function countMap(rows = []) {
  return rows.reduce((result, row) => {
    result[row._id || 'UNKNOWN'] = row.count;
    return result;
  }, {});
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

exports.getOverview = async (req, res) => {
  try {
    const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      facilityTotal,
      facilityActive,
      facilityLinked,
      facilityHfrApproved,
      facilityConnectorActive,
      transactionTotal,
      transaction24h,
      transactionStatusRows,
      webhook24h,
      webhookStatusRows,
      jobStatusRows,
      activeConsents,
      recentTransactions,
      recentWebhookEvents,
    ] = await Promise.all([
      AbdmFacility.countDocuments(),
      AbdmFacility.countDocuments({ active: true }),
      AbdmFacility.countDocuments({ softwareLinkageStatus: 'LINKED' }),
      AbdmFacility.countDocuments({ hfrStatus: 'APPROVED' }),
      AbdmFacility.countDocuments({ 'connector.status': 'ACTIVE' }),
      AbdmTransaction.countDocuments(),
      AbdmTransaction.countDocuments({ createdAt: { $gte: since24Hours } }),
      AbdmTransaction.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      AbdmWebhookEvent.countDocuments({ createdAt: { $gte: since24Hours } }),
      AbdmWebhookEvent.aggregate([{ $group: { _id: '$processingStatus', count: { $sum: 1 } } }]),
      AbdmJob.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      AbdmConsent.countDocuments({ status: 'GRANTED', $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }),
      AbdmTransaction.find({}).sort({ createdAt: -1 }).limit(8).lean(),
      AbdmWebhookEvent.find({}).sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    return res.json({
      success: true,
      config: {
        appRole: abdmConfig.appRole,
        environment: abdmConfig.environment,
        bridgeId: abdmConfig.bridgeId || null,
        publicBaseUrl: abdmConfig.publicBaseUrl || null,
        features: {
          m1: abdmConfig.featureM1,
          m2: abdmConfig.featureM2,
          m3: abdmConfig.featureM3,
        },
      },
      stats: {
        facilities: {
          total: facilityTotal,
          active: facilityActive,
          linked: facilityLinked,
          hfrApproved: facilityHfrApproved,
          connectorActive: facilityConnectorActive,
        },
        transactions: {
          total: transactionTotal,
          last24Hours: transaction24h,
          byStatus: countMap(transactionStatusRows),
        },
        webhooks: {
          last24Hours: webhook24h,
          byStatus: countMap(webhookStatusRows),
        },
        jobs: {
          byStatus: countMap(jobStatusRows),
        },
        consents: {
          activeGranted: activeConsents,
        },
      },
      recentTransactions,
      recentWebhookEvents,
    });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};


exports.listConsents = async (req, res) => {
  try {
    const filter = {};
    if (req.query.facilityId) filter.facilityId = req.query.facilityId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.consentId) filter.consentId = req.query.consentId;

    const consents = await AbdmConsent.find(filter)
      .select('-permission -purpose -rawReference')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, consents });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getConsent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.consentRecordId)) {
      return res.status(400).json({ success: false, message: 'Invalid consent record ID' });
    }

    const consent = await AbdmConsent.findById(req.params.consentRecordId).lean();
    if (!consent) return res.status(404).json({ success: false, message: 'ABDM consent record not found' });
    return res.json({ success: true, consent });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listJobs = async (req, res) => {
  try {
    const filter = {};
    if (req.query.facilityId) filter.facilityId = req.query.facilityId;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const jobs = await AbdmJob.find(filter).select('-payload').sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, jobs });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getJob = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.jobId)) {
      return res.status(400).json({ success: false, message: 'Invalid ABDM job ID' });
    }

    const job = await AbdmJob.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ success: false, message: 'ABDM job not found' });
    return res.json({ success: true, job });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getTransaction = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.transactionId)) {
      return res.status(400).json({ success: false, message: 'Invalid transaction ID' });
    }

    const transaction = await AbdmTransaction.findById(req.params.transactionId).lean();
    if (!transaction) return res.status(404).json({ success: false, message: 'ABDM transaction not found' });
    return res.json({ success: true, transaction });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getWebhookEvent = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.eventId)) {
      return res.status(400).json({ success: false, message: 'Invalid webhook event ID' });
    }

    const event = await AbdmWebhookEvent.findById(req.params.eventId).select('+payload').lean();
    if (!event) return res.status(404).json({ success: false, message: 'ABDM webhook event not found' });
    return res.json({ success: true, event });
  } catch (error) {
    req.auditError = { message: error.message };
    return res.status(500).json({ success: false, message: error.message });
  }
};
