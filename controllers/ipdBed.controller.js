const Bed = require('../models/Bed');
const Room = require('../models/Room');
const IPDAdmission = require('../models/IPDAdmission');
const { requireHospitalId } = require('../services/tenantScope.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

function filters(req, hospitalId, base = {}) {
  const f = { hospitalId, isActive: true, ...base };

  ['status', 'wardId', 'roomId', 'bedType'].forEach((k) => {
    if (req.query[k]) f[k] = req.query[k];
  });

  return f;
}

function populate(query) {
  return query
    .populate('roomId', 'room_number type operationalStatus')
    .populate('wardId', 'name code floor type')
    .populate({
      path: 'currentAdmissionId',
      select: 'admissionNumber patientId primaryDoctorId admissionDate status coverageId',
      populate: [
        { path: 'patientId', select: 'first_name last_name patientId uhid phone gender' },
        { path: 'primaryDoctorId', select: 'firstName lastName specialization' }
      ]
    });
}

exports.createBed = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    if (!req.body.bedNumber || !req.body.roomId || !req.body.bedType) {
      return res.status(400).json({
        success: false,
        error: 'bedNumber, roomId and bedType are required'
      });
    }

    const room = await Room.findOne({ _id: req.body.roomId, hospitalId });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    const count = await Bed.countDocuments({ hospitalId });

    const bed = await Bed.create({
      ...req.body,
      hospitalId,
      bedCode: req.body.bedCode || `BED${String(count + 1).padStart(4, '0')}`,
      wardId: req.body.wardId || room.wardId,
      status: 'Available',
      createdBy: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Bed created successfully',
      bed
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.getAllBeds = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const beds = await populate(Bed.find(filters(req, hospitalId)))
      .sort({ bedNumber: 1 });

    res.json({ success: true, beds });
  } catch (e) {
    fail(res, e);
  }
};

exports.getAvailableBeds = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const f = filters(req, hospitalId, { status: 'Available' });

    if (req.query.isolation === 'true') {
      f.isolationCapable = true;
    }

    if (req.query.gender) {
      f.genderPolicy = { $in: ['any', req.query.gender] };
    }

    const beds = await populate(Bed.find(f))
      .sort({ dailyCharge: 1, bedNumber: 1 });

    res.json({ success: true, beds });
  } catch (e) {
    fail(res, e);
  }
};

exports.getOccupiedBeds = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const beds = await populate(Bed.find(filters(req, hospitalId, { status: 'Occupied' })))
      .sort({ bedNumber: 1 });

    res.json({ success: true, beds });
  } catch (e) {
    fail(res, e);
  }
};

exports.getBedById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const bed = await populate(Bed.findOne({
      _id: req.params.id,
      hospitalId
    }));

    if (!bed) {
      return res.status(404).json({
        success: false,
        error: 'Bed not found'
      });
    }

    res.json({ success: true, bed });
  } catch (e) {
    fail(res, e);
  }
};

exports.updateBed = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const blocked = [
      'currentAdmissionId',
      'reservedTransferId',
      'reservationExpiresAt',
      'hospitalId'
    ];

    const patch = { ...req.body };
    blocked.forEach((k) => delete patch[k]);

    const bed = await Bed.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      patch,
      { new: true, runValidators: true }
    );

    if (!bed) {
      return res.status(404).json({
        success: false,
        error: 'Bed not found'
      });
    }

    res.json({
      success: true,
      message: 'Bed updated successfully',
      bed
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.updateBedStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const bed = await Bed.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!bed) {
      return res.status(404).json({
        success: false,
        error: 'Bed not found'
      });
    }

    if (
      ['Occupied', 'Reserved'].includes(bed.status) &&
      req.body.status === 'Available' &&
      (bed.currentAdmissionId || bed.reservedTransferId)
    ) {
      return res.status(409).json({
        success: false,
        error: 'Use discharge, transfer cancellation, or cleaning completion to release this bed'
      });
    }

    bed.status = req.body.status;

    if (req.body.status === 'Available') {
      bed.currentAdmissionId = null;
      bed.reservedTransferId = null;
      bed.reservationExpiresAt = null;
    }

    await bed.save();

    res.json({ success: true, bed });
  } catch (e) {
    fail(res, e);
  }
};

exports.deleteBed = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const bed = await Bed.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!bed) {
      return res.status(404).json({
        success: false,
        error: 'Bed not found'
      });
    }

    if (['Occupied', 'Reserved'].includes(bed.status)) {
      return res.status(409).json({
        success: false,
        error: 'Cannot deactivate an occupied or reserved bed'
      });
    }

    bed.isActive = false;
    await bed.save();

    res.json({
      success: true,
      message: 'Bed deactivated successfully'
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.syncBedStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const activeStatuses = [
      'Admitted',
      'Under Treatment',
      'Discharge Initiated',
      'Discharge Summary Pending',
      'Billing Pending',
      'Payment Pending',
      'Ready for Discharge'
    ];

    const beds = await Bed.find({ hospitalId, isActive: true });
    const updates = [];

    for (const bed of beds) {
      if (bed.status === 'Reserved') continue;

      const admission = await IPDAdmission.findOne({
        hospitalId,
        bedId: bed._id,
        status: { $in: activeStatuses }
      });

      const target = admission
        ? 'Occupied'
        : bed.status === 'Cleaning' || bed.status === 'Maintenance'
          ? bed.status
          : 'Available';

      if (
        bed.status !== target ||
        String(bed.currentAdmissionId || '') !== String(admission?._id || '')
      ) {
        updates.push({
          bedId: bed._id,
          from: bed.status,
          to: target
        });

        bed.status = target;
        bed.currentAdmissionId = admission?._id || null;
        await bed.save();
      }
    }

    res.json({ success: true, updates });
  } catch (e) {
    fail(res, e);
  }
};