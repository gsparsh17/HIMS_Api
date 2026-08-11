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

const HRStaffProfile = require('../models/HRStaffProfile');

exports.quickPunch = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { deviceUserCode, employeeCode, employeeId, direction, deviceCode } = req.body;

    let employee = null;

    if (employeeId) {
      employee = await HRStaffProfile.findOne({ _id: employeeId, hospital_id: hospitalId });
    }

    if (!employee && employeeCode) {
      employee = await HRStaffProfile.findOne({ employee_code: String(employeeCode).trim(), hospital_id: hospitalId });
    }

    if (!employee && deviceUserCode) {
      const mapping = await BiometricEmployeeMap.findOne({
        hospitalId,
        deviceUserCode: String(deviceUserCode).trim(),
        active: true
      });
      if (mapping?.employeeId) {
        employee = await HRStaffProfile.findById(mapping.employeeId);
      } else {
        employee = await HRStaffProfile.findOne({
          hospital_id: hospitalId,
          $or: [
            { employee_code: String(deviceUserCode).trim() },
            { phone: String(deviceUserCode).trim() }
          ]
        });
      }
    }

    if (!employee && req.user) {
      employee = await HRStaffProfile.findOne({
        $or: [
          { user_id: req.user._id },
          ...(req.user.staff_profile_id ? [{ _id: req.user.staff_profile_id }] : [])
        ]
      });
    }

    if (!employee) {
      return res.status(404).json({
        success: false,
        error: 'Employee profile not found. Please select or enroll employee.'
      });
    }

    let device = null;
    if (deviceCode) {
      device = await BiometricDevice.findOne({ code: deviceCode, hospitalId });
    }
    if (!device) {
      device = await BiometricDevice.findOne({ hospitalId, status: 'active' });
    }
    if (!device) {
      device = await BiometricDevice.create({
        hospitalId,
        code: 'BIO-MAIN-01',
        vendor: 'MediQliq Biometric Scanner',
        model: 'USB-Bridge-v1',
        location: 'Main Entrance / Pharmacy Desk',
        status: 'active',
        auth: { keyId: `bio_${Date.now()}`, secretHash: 'default' },
        createdBy: req.user._id,
        updatedBy: req.user._id
      });
    }

    const userCode = deviceUserCode || employee.employee_code || String(employee._id);
    await BiometricEmployeeMap.findOneAndUpdate(
      { hospitalId, deviceId: device._id, deviceUserCode: userCode },
      { $set: { employeeId: employee._id, active: true, mappedBy: req.user._id, mappedAt: new Date() } },
      { upsert: true, new: true }
    );

    const now = new Date();
    const punch = await AttendancePunch.create({
      hospitalId,
      deviceId: device._id,
      employeeId: employee._id,
      deviceUserCode: userCode,
      timestamp: now,
      direction: direction || 'unknown',
      source: 'biometric',
      rawEventId: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      validationStatus: 'valid',
      raw: { scannedBy: req.user?._id, method: 'biometric_scanner' }
    });

    const attendance = await reconcilePunches({
      hospitalId,
      employeeIds: [employee._id],
      from: now,
      to: now,
      actorUserId: req.user?._id
    });

    res.json({
      success: true,
      message: `Biometric attendance recorded for ${employee.full_name}`,
      action: punch.direction === 'in' ? 'Check In' : punch.direction === 'out' ? 'Check Out' : 'Attendance Punch',
      employee: {
        _id: employee._id,
        full_name: employee.full_name,
        employee_code: employee.employee_code,
        staff_type: employee.staff_type,
        department_name: employee.department_name || employee.department?.name || 'General'
      },
      punch: {
        timestamp: punch.timestamp,
        direction: punch.direction,
        deviceId: device._id,
        deviceCode: device.code
      },
      attendance
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.listEmployeesForMapping = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const employees = await HRStaffProfile.find({ hospital_id: hospitalId, status: { $ne: 'terminated' } })
      .select('employee_code full_name staff_type designation department_name phone email')
      .sort({ full_name: 1 })
      .lean();

    const mappings = await BiometricEmployeeMap.find({ hospitalId, active: true }).lean();
    const mapByEmpId = new Map(mappings.map(m => [String(m.employeeId), m]));

    const list = employees.map(emp => ({
      ...emp,
      isMapped: mapByEmpId.has(String(emp._id)),
      mapping: mapByEmpId.get(String(emp._id)) || null
    }));

    res.json({ success: true, data: list });
  } catch (e) {
    fail(res, e);
  }
};