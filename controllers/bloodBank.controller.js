const { operationNow } = require('../utils/operationTimeContext');
'use strict';

const BloodDonor = require('../models/BloodDonor');
const BloodUnit = require('../models/BloodUnit');
const BloodComponentRequest = require('../models/BloodComponentRequest');
const DomainEvent = require('../models/DomainEvent');
const { hospitalId, required, ref, sendError, postProviderJson } = require('../utils/functionalDomain');

exports.registerDonor = async (req, res) => {
  try {
    required(req.body, ['name', 'dateOfBirth', 'bloodGroup']);

    const s = req.body.screening || {};
    const eligible = s.consent === true &&
      s.hemoglobinOk !== false &&
      s.infectionScreenNegative !== false &&
      s.medicallyFit !== false;

    const row = await BloodDonor.create({
      hospitalId: hospitalId(req),
      donorNumber: req.body.donorNumber || ref('DON'),
      name: req.body.name,
      dateOfBirth: req.body.dateOfBirth,
      phone: req.body.phone,
      bloodGroup: req.body.bloodGroup,
      screening: {
        ...s,
        screenedBy: req.user._id,
        screenedAt: operationNow()
      },
      eligibilityStatus: eligible ? 'eligible' : 'deferred',
      deferralReason: eligible
        ? undefined
        : (req.body.deferralReason || 'Screening criteria not met'),
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row,
      eligible
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listDonors = async (req, res) => {
  const f = {
    hospitalId: hospitalId(req)
  };

  if (req.query.eligibilityStatus) {
    f.eligibilityStatus = req.query.eligibilityStatus;
  }

  const data = await BloodDonor
    .find(f)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json({ success: true, data });
};

exports.addUnit = async (req, res) => {
  try {
    required(req.body, ['bloodGroup', 'component']);

    let donor = null;

    if (req.body.donorId) {
      donor = await BloodDonor.findOne({
        _id: req.body.donorId,
        hospitalId: hospitalId(req),
        eligibilityStatus: 'eligible'
      });

      if (!donor) {
        return res.status(409).json({
          error: 'Only an eligible donor can supply a unit'
        });
      }
    }

    const row = await BloodUnit.create({
      hospitalId: hospitalId(req),
      unitNumber: req.body.unitNumber || ref('BLD'),
      donorId: donor?._id,
      bloodGroup: req.body.bloodGroup,
      component: req.body.component,
      collectedAt: req.body.collectedAt || operationNow(),
      expiresAt: req.body.expiresAt,
      storageLocation: req.body.storageLocation || 'Blood Bank',
      volumeMl: req.body.volumeMl,
      status: 'available',
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.inventory = async (req, res) => {
  try {
    const hid = hospitalId(req);
    const now = operationNow();

    const expired = await BloodUnit.updateMany(
      {
        hospitalId: hid,
        status: 'available',
        expiresAt: { $lt: now }
      },
      {
        $set: {
          status: 'expired',
          updatedBy: req.user._id
        }
      }
    );

    const match = {
      hospitalId: require('mongoose').Types.ObjectId.createFromHexString(String(hid)),
      status: 'available'
    };

    if (req.query.bloodGroup) {
      match.bloodGroup = req.query.bloodGroup;
    }

    if (req.query.component) {
      match.component = req.query.component;
    }

    const data = await BloodUnit.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            bloodGroup: '$bloodGroup',
            component: '$component'
          },
          availableUnits: { $sum: 1 },
          earliestExpiry: { $min: '$expiresAt' }
        }
      },
      {
        $project: {
          _id: 0,
          bloodGroup: '$_id.bloodGroup',
          component: '$_id.component',
          availableUnits: 1,
          earliestExpiry: 1
        }
      },
      {
        $sort: {
          bloodGroup: 1,
          component: 1
        }
      }
    ]);

    return res.json({
      success: true,
      data,
      expiredUnitsMarked: Number(expired.modifiedCount || 0)
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.requestComponents = async (req, res) => {
  try {
    required(req.body, ['bloodGroup', 'component', 'unitsRequested']);

    const units = Number(req.body.unitsRequested);

    if (!Number.isInteger(units) || units < 1) {
      return res.status(400).json({
        error: 'unitsRequested must be positive integer'
      });
    }

    const available = await BloodUnit
      .find({
        hospitalId: hospitalId(req),
        bloodGroup: req.body.bloodGroup,
        component: req.body.component,
        status: 'available'
      })
      .sort({ expiresAt: 1 })
      .limit(units);

    const isFullyAvailable = available.length >= units;

    const row = await BloodComponentRequest.create({
      hospitalId: hospitalId(req),
      requestNumber: req.body.requestNumber || ref('BCR'),
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      bloodGroup: req.body.bloodGroup,
      component: req.body.component,
      unitsRequested: units,
      priority: req.body.priority || 'routine',
      status: isFullyAvailable ? 'reserved' : 'shortage',
      reservedUnitIds: available.map(x => x._id),
      shortageReason: isFullyAvailable
        ? undefined
        : 'Insufficient matching stock',
      requestedBy: req.user._id,
      timeline: [
        {
          activity: 'requested',
          at: operationNow(),
          by: req.user._id,
          note: req.body.note
        },
        {
          activity: isFullyAvailable ? 'stock_reserved' : 'shortage_identified',
          at: operationNow(),
          by: req.user._id,
          note: isFullyAvailable
            ? `${available.length} unit(s) reserved`
            : 'Insufficient matching stock'
        }
      ]
    });

    if (isFullyAvailable) {
      await BloodUnit.updateMany(
        { _id: { $in: available.map(x => x._id) } },
        {
          $set: {
            status: 'reserved',
            reservedForRequestId: row._id,
            updatedBy: req.user._id
          }
        }
      );
    }

    return res.status(201).json({
      success: true,
      data: row,
      available: available.length
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.dispatch = async (req, res) => {
  try {
    const row = await BloodComponentRequest.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Blood component request not found'
      });
    }

    if (row.status !== 'reserved') {
      return res.status(409).json({
        error: `Request status ${row.status} cannot be dispatched`
      });
    }

    const units = await BloodUnit.find({
      _id: { $in: row.reservedUnitIds },
      hospitalId: hospitalId(req),
      status: 'reserved'
    });

    if (units.length < row.unitsRequested) {
      return res.status(409).json({
        error: 'Reserved stock is incomplete'
      });
    }

    await BloodUnit.updateMany(
      { _id: { $in: units.map(x => x._id) } },
      {
        $set: {
          status: 'dispatched',
          updatedBy: req.user._id
        }
      }
    );

    row.status = 'dispatched';
    row.dispatchedAt = operationNow();
    row.dispatchedBy = req.user._id;
    row.delayReason = req.body.delayReason;

    row.timeline.push({
      activity: 'dispatched',
      at: row.dispatchedAt,
      by: req.user._id,
      note: req.body.delayReason || `${units.length} unit(s) dispatched`
    });

    await row.save();

    const turnaroundMinutes = Math.max(
      0,
      Math.round((row.dispatchedAt - row.requestedAt) / 60000)
    );

    return res.json({
      success: true,
      data: row,
      turnaroundMinutes
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.publishUhiStock = async (req, res) => {
  try {
    const hid = hospitalId(req);

    const stock = await BloodUnit.aggregate([
      {
        $match: {
          hospitalId: require('mongoose').Types.ObjectId.createFromHexString(String(hid)),
          status: 'available'
        }
      },
      {
        $group: {
          _id: {
            bloodGroup: '$bloodGroup',
            component: '$component'
          },
          availableUnits: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          bloodGroup: '$_id.bloodGroup',
          component: '$_id.component',
          availableUnits: 1
        }
      }
    ]);

    const exchangeReference = req.body.exchangeReference || ref('UHI');

    let providerResult = {
      configured: false,
      delivered: false
    };

    const providerUrl = process.env.UHI_BLOOD_STOCK_URL ||
      (process.env.NODE_ENV !== 'production' ? req.body.endpoint : null);

    if (providerUrl) {
      const result = await postProviderJson(
        providerUrl,
        {
          exchangeReference,
          hospitalId: String(hid),
          publishedAt: operationNow().toISOString(),
          stock
        },
        {
          label: 'UHI blood-stock provider',
          allowedHosts: process.env.UHI_ALLOWED_HOSTS,
          headers: process.env.UHI_API_KEY
            ? { Authorization: `Bearer ${process.env.UHI_API_KEY}` }
            : {}
        }
      );

      providerResult = {
        configured: true,
        delivered: true,
        response: result
      };
    }

    const event = await DomainEvent.create({
      eventId: ref('EVT'),
      eventType: 'blood_stock_uhi_published',
      hospitalId: hid,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      entityType: 'Hospital',
      entityId: hid,
      correlationId: exchangeReference,
      metadata: {
        provider: req.body.provider || 'UHI',
        providerConfigured: Boolean(providerUrl),
        delivered: providerResult.delivered,
        stock
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        exchangeReference,
        stock,
        eventId: event.eventId,
        provider: providerResult
      }
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.uhiStock = async (req, res) => {
  try {
    const hid = hospitalId(req);

    const match = {
      hospitalId: require('mongoose').Types.ObjectId.createFromHexString(String(hid)),
      status: 'available'
    };

    if (req.query.bloodGroup) {
      match.bloodGroup = req.query.bloodGroup;
    }

    if (req.query.component) {
      match.component = req.query.component;
    }

    const data = await BloodUnit.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            bloodGroup: '$bloodGroup',
            component: '$component'
          },
          availableUnits: { $sum: 1 },
          earliestExpiry: { $min: '$expiresAt' }
        }
      },
      {
        $project: {
          _id: 0,
          bloodGroup: '$_id.bloodGroup',
          component: '$_id.component',
          availableUnits: 1,
          earliestExpiry: 1
        }
      }
    ]);

    return res.json({
      success: true,
      data,
      source: 'hospital_blood_bank',
      shareableVia: 'UHI'
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.uhiHistory = async (req, res) => {
  const data = await DomainEvent
    .find({
      hospitalId: hospitalId(req),
      eventType: 'blood_stock_uhi_published'
    })
    .sort({ occurredAt: -1 })
    .limit(50)
    .lean();

  return res.json({
    success: true,
    data
  });
};