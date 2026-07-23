const crypto = require('crypto');
const BiometricDevice = require('../models/BiometricDevice');
const BiometricEmployeeMap = require('../models/BiometricEmployeeMap');
const AttendancePunch = require('../models/AttendancePunch');
const { requireHospitalId } = require('../services/tenantScope.service');
const { reconcilePunches } = require('../services/attendanceReconciliation.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function verifySignature(secret, timestamp, body, signature) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.listDevices = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await BiometricDevice
      .find({ hospitalId })
      .select('-auth.secretHash')
      .sort({ code: 1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.createDevice = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const secret = crypto.randomBytes(32).toString('hex');

    const data = await BiometricDevice.create({
      ...req.body,
      hospitalId,
      auth: {
        ...(req.body.auth || {}),
        keyId: req.body.keyId || `bio_${Date.now()}`,
        secretHash: sha(secret)
      },
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    const object = data.toObject();
    delete object.auth.secretHash;

    res.status(201).json({
      success: true,
      data: object,
      credentials: {
        keyId: data.auth.keyId,
        secret
      }
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.mapEmployee = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const device = await BiometricDevice.findOne({
      _id: req.body.deviceId,
      hospitalId
    });

    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }

    const data = await BiometricEmployeeMap.findOneAndUpdate(
      {
        hospitalId,
        deviceId: device._id,
        deviceUserCode: req.body.deviceUserCode
      },
      {
        $set: {
          employeeId: req.body.employeeId,
          identifierType: req.body.identifierType || 'user_code',
          active: true,
          mappedBy: req.user._id,
          mappedAt: new Date()
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.listMappings = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.deviceId) {
      filter.deviceId = req.query.deviceId;
    }

    const data = await BiometricEmployeeMap
      .find(filter)
      .populate('deviceId', 'code vendor model location')
      .populate('employeeId', 'employee_code full_name designation department_name')
      .sort({ createdAt: -1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.ingest = async (req, res) => {
  try {
    const keyId = req.get('x-biometric-key-id');
    const timestamp = req.get('x-biometric-timestamp');
    const signature = req.get('x-biometric-signature');

    if (!keyId || !timestamp || !signature) {
      return res.status(401).json({
        success: false,
        error: 'Missing device authentication headers'
      });
    }

    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
      return res.status(401).json({
        success: false,
        error: 'Stale device request'
      });
    }

    const device = await BiometricDevice.findOne({
      'auth.keyId': keyId,
      status: 'active'
    });

    if (!device) {
      return res.status(401).json({
        success: false,
        error: 'Unknown device'
      });
    }

    // The stored value is a one-way hash. Runtime deployments should store the
    // raw secret in a secret vault and expose it as BIO_<KEYID>_SECRET.
    const envKey = `BIO_${String(keyId).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_SECRET`;
    const secret = process.env[envKey];

    if (
      !secret ||
      sha(secret) !== device.auth.secretHash ||
      !verifySignature(secret, timestamp, req.body, signature)
    ) {
      return res.status(401).json({
        success: false,
        error: 'Invalid device signature'
      });
    }

    const events = Array.isArray(req.body.events) ? req.body.events : [];
    const results = [];

    for (const event of events) {
      if (!event.rawEventId || !event.deviceUserCode || !event.timestamp) {
        results.push({
          rawEventId: event.rawEventId,
          status: 'invalid'
        });
        continue;
      }

      const mapping = await BiometricEmployeeMap.findOne({
        hospitalId: device.hospitalId,
        deviceId: device._id,
        deviceUserCode: String(event.deviceUserCode),
        active: true
      });

      try {
        const punch = await AttendancePunch.create({
          hospitalId: device.hospitalId,
          deviceId: device._id,
          employeeId: mapping?.employeeId,
          deviceUserCode: String(event.deviceUserCode),
          timestamp: new Date(event.timestamp),
          direction: event.direction || 'unknown',
          source: 'biometric',
          rawEventId: String(event.rawEventId),
          validationStatus: mapping ? 'valid' : 'unmapped',
          validationMessage: mapping ? undefined : 'No active employee mapping',
          raw: event
        });

        results.push({
          rawEventId: event.rawEventId,
          status: punch.validationStatus,
          id: punch._id
        });
      } catch (e) {
        if (e.code === 11000) {
          results.push({
            rawEventId: event.rawEventId,
            status: 'duplicate'
          });
        } else {
          throw e;
        }
      }
    }

    device.lastSyncAt = new Date();
    device.lastEventAt = events.length
      ? new Date(events[events.length - 1].timestamp)
      : device.lastEventAt;

    await device.save();

    await reconcilePunches({
      hospitalId: device.hospitalId,
      from: req.body.from,
      to: req.body.to,
      actorUserId: null
    });

    res.json({
      success: true,
      accepted: results.filter((r) => r.status !== 'duplicate').length,
      results
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.reconcile = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await reconcilePunches({
      hospitalId,
      employeeIds: req.body.employeeIds,
      from: req.body.from,
      to: req.body.to,
      actorUserId: req.user._id
    });

    await appendDomainEvent({
      req,
      eventType: 'attendance.punch_reconciled',
      entityType: 'Hospital',
      entityId: hospitalId,
      hospitalId,
      afterSummary: { records: data.length }
    });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.exceptions = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await AttendancePunch
      .find({
        hospitalId,
        validationStatus: { $in: ['unmapped', 'invalid', 'exception'] }
      })
      .populate('deviceId', 'code location')
      .populate('employeeId', 'employee_code full_name')
      .sort({ timestamp: -1 })
      .limit(1000);

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};