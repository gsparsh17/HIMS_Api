const crypto = require('crypto');
const fs = require('fs');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const { requireHospitalId } = require('../services/tenantScope.service');
const { quotePricing } = require('../services/pricingEngine.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

exports.listPayers = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.type) {
      filter.type = req.query.type;
    }

    if (req.query.active !== undefined) {
      filter.isActive = req.query.active === 'true';
    }

    const data = await Payer.find(filter).sort({ type: 1, name: 1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.createPayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await Payer.create({
      ...req.body,
      hospitalId,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    res.status(201).json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.updatePayer = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await Payer.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { ...req.body, updatedBy: req.user._id },
      { new: true, runValidators: true }
    );

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Payer not found'
      });
    }

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.listRateCards = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.payerId) {
      filter.payerId = req.query.payerId;
    }

    if (req.query.status) {
      filter.status = req.query.status;
    }

    if (req.query.effectiveOn) {
      const d = new Date(req.query.effectiveOn);
      filter.effectiveFrom = { $lte: d };
      filter.$or = [
        { effectiveTo: null },
        { effectiveTo: { $exists: false } },
        { effectiveTo: { $gte: d } }
      ];
    }

    const data = await RateCard
      .find(filter)
      .populate('payerId', 'code name type')
      .sort({ effectiveFrom: -1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.createRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const payer = await Payer.findOne({
      _id: req.body.payerId,
      hospitalId
    });

    if (!payer) {
      return res.status(404).json({
        success: false,
        error: 'Payer not found'
      });
    }

    const data = await RateCard.create({
      ...req.body,
      hospitalId,
      status: req.body.status || 'staging',
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    res.status(201).json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.getRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await RateCard
      .findOne({ _id: req.params.id, hospitalId })
      .populate('payerId');

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Rate card not found'
      });
    }

    const items = await RateCardItem
      .find({ rateCardId: data._id })
      .sort({ 'sourceRow.serialNumber': 1, externalCode: 1 })
      .limit(Number(req.query.limit || 5000));

    res.json({ success: true, data, items });
  } catch (e) {
    fail(res, e);
  }
};

exports.upsertRateCardItems = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const card = await RateCard.findOne({
      _id: req.params.id,
      hospitalId,
      status: { $in: ['draft', 'staging', 'pending_approval'] }
    });

    if (!card) {
      return res.status(409).json({
        success: false,
        error: 'Rate card is not editable'
      });
    }

    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!items.length) {
      return res.status(400).json({
        success: false,
        error: 'items array is required'
      });
    }

    const operations = items.map((item) => ({
      updateOne: {
        filter: {
          rateCardId: card._id,
          externalCode: String(item.externalCode).toUpperCase()
        },
        update: {
          $set: {
            ...item,
            externalCode: String(item.externalCode).toUpperCase(),
            hospitalId,
            payerId: card.payerId,
            rateCardId: card._id
          }
        },
        upsert: true
      }
    }));

    await RateCardItem.bulkWrite(operations, { ordered: false });

    card.itemCount = await RateCardItem.countDocuments({ rateCardId: card._id });
    card.updatedBy = req.user._id;
    await card.save();

    res.json({ success: true, itemCount: card.itemCount });
  } catch (e) {
    fail(res, e);
  }
};

exports.approveRateCard = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const card = await RateCard.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!card) {
      return res.status(404).json({
        success: false,
        error: 'Rate card not found'
      });
    }

    if (!card.approval.firstApprovedBy) {
      card.approval.firstApprovedBy = req.user._id;
      card.approval.firstApprovedAt = new Date();
      card.status = 'pending_approval';
    } else if (String(card.approval.firstApprovedBy) === String(req.user._id)) {
      return res.status(409).json({
        success: false,
        error: 'Second approval must be performed by another user'
      });
    } else {
      card.approval.secondApprovedBy = req.user._id;
      card.approval.secondApprovedAt = new Date();
      card.status = 'active';
      card.approval.activatedBy = req.user._id;
      card.approval.activatedAt = new Date();

      await RateCard.updateMany(
        {
          hospitalId,
          payerId: card.payerId,
          status: 'active',
          _id: { $ne: card._id },
          effectiveFrom: { $lte: card.effectiveFrom }
        },
        {
          $set: {
            status: 'closed',
            effectiveTo: new Date(card.effectiveFrom.getTime() - 1)
          }
        }
      );
    }

    await card.save();

    await appendDomainEvent({
      req,
      eventType: card.status === 'active'
        ? 'rate_card.activated'
        : 'rate_card.first_approved',
      entityType: 'RateCard',
      entityId: card._id,
      hospitalId,
      afterSummary: {
        status: card.status,
        version: card.version,
        itemCount: card.itemCount
      }
    });

    res.json({ success: true, data: card });
  } catch (e) {
    fail(res, e);
  }
};

exports.quote = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await quotePricing({ ...req.body, hospitalId });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.checksum = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'file is required'
      });
    }

    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(req.file.path));

    res.json({
      success: true,
      checksum: hash.digest('hex'),
      filename: req.file.originalname
    });
  } catch (e) {
    fail(res, e);
  }
};