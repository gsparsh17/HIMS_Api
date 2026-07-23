const Room = require('../models/Room');
const Bed = require('../models/Bed');
const { requireHospitalId } = require('../services/tenantScope.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

async function withOccupancy(rooms) {
  const ids = rooms.map((room) => room._id);

  const rows = await Bed.aggregate([
    {
      $match: {
        roomId: { $in: ids },
        isActive: true
      }
    },
    {
      $group: {
        _id: '$roomId',
        total: { $sum: 1 },
        occupied: {
          $sum: { $cond: [{ $eq: ['$status', 'Occupied'] }, 1, 0] }
        },
        reserved: {
          $sum: { $cond: [{ $eq: ['$status', 'Reserved'] }, 1, 0] }
        },
        available: {
          $sum: { $cond: [{ $eq: ['$status', 'Available'] }, 1, 0] }
        }
      }
    }
  ]);

  const map = new Map(rows.map((r) => [String(r._id), r]));

  return rooms.map((room) => {
    const data = room.toObject ? room.toObject() : room;
    const occupancy = map.get(String(room._id)) || {
      total: 0,
      occupied: 0,
      reserved: 0,
      available: 0
    };

    const computedStatus = data.operationalStatus !== 'open'
      ? (data.operationalStatus === 'closed' ? 'Closed' : 'Maintenance')
      : occupancy.total === 0 || occupancy.occupied + occupancy.reserved === 0
        ? 'Available'
        : occupancy.occupied + occupancy.reserved >= occupancy.total
          ? 'Full'
          : 'Partially Occupied';

    return { ...data, occupancy, computedStatus };
  });
}

exports.createRoom = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const room = await Room.create({ ...req.body, hospitalId });

    res.status(201).json({ success: true, data: room });
  } catch (e) {
    fail(res, e);
  }
};

exports.getAllRooms = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.wardId) {
      filter.wardId = req.query.wardId;
    }

    const rooms = await Room
      .find(filter)
      .populate('Department', 'name')
      .populate('wardId', 'name code');

    res.json({
      success: true,
      data: await withOccupancy(rooms)
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      req.body,
      { new: true, runValidators: true }
    );

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    res.json({ success: true, data: room });
  } catch (e) {
    fail(res, e);
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const occupied = await Bed.exists({
      hospitalId,
      roomId: req.params.id,
      status: { $in: ['Occupied', 'Reserved'] }
    });

    if (occupied) {
      return res.status(409).json({
        success: false,
        error: 'Room has occupied or reserved beds'
      });
    }

    const room = await Room.findOneAndDelete({
      _id: req.params.id,
      hospitalId
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    res.json({
      success: true,
      message: 'Room deleted successfully'
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.getRoomById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const room = await Room
      .findOne({ _id: req.params.id, hospitalId })
      .populate('Department', 'name')
      .populate('wardId', 'name code');

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    res.json({
      success: true,
      data: (await withOccupancy([room]))[0]
    });
  } catch (e) {
    fail(res, e);
  }
};