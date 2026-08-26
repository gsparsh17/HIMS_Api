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
    const body = { ...req.body };

    if (!body.wardId || body.wardId === '') delete body.wardId;
    if (body.department && !body.Department) body.Department = body.department;
    if (!body.Department || body.Department === '') delete body.Department;
    delete body.department;
    if (!body.assigned_patient_id || body.assigned_patient_id === '') delete body.assigned_patient_id;

    if (body.type === 'Operation Theatre' || body.type === 'OT') {
      body.type = 'Operation Theater';
    }

    const normalizedRoomNumber = String(body.room_number || '').trim();
    if (!normalizedRoomNumber) {
      return res.status(400).json({ success: false, error: 'Room number is required' });
    }
    body.room_number = normalizedRoomNumber;

    const existing = await Room.findOne({ hospitalId, room_number: normalizedRoomNumber });
    if (existing) {
      if (existing.is_active === false) {
        existing.is_active = true;
        existing.deleted_at = null;
        existing.deleted_by = null;
        existing.deletion_reason = '';
        Object.assign(existing, body);
        await existing.save();
        const populated = await Room.findById(existing._id)
          .populate('Department', 'name')
          .populate('wardId', 'name code');
        return res.status(201).json({ success: true, data: populated });
      }
      return res.status(409).json({ success: false, error: `Room ${normalizedRoomNumber} already exists in this hospital` });
    }

    const room = await Room.create({ ...body, hospitalId });
    const populated = await Room.findById(room._id)
      .populate('Department', 'name')
      .populate('wardId', 'name code');

    res.status(201).json({ success: true, data: populated });
  } catch (e) {
    fail(res, e);
  }
};

exports.getAllRooms = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId, is_active: { $ne: false } };

    if (req.query.wardId) {
      filter.wardId = req.query.wardId;
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }

    const rooms = await Room
      .find(filter)
      .populate('Department', 'name')
      .populate('wardId', 'name code')
      .sort({ room_number: 1 });

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
    const body = { ...req.body };

    if (body.wardId === '') body.wardId = null;
    if (body.department && !body.Department) body.Department = body.department;
    if (body.Department === '') body.Department = null;
    delete body.department;
    if (body.assigned_patient_id === '') body.assigned_patient_id = null;

    if (body.type === 'Operation Theatre' || body.type === 'OT') {
      body.type = 'Operation Theater';
    }

    if (body.room_number) {
      body.room_number = String(body.room_number).trim();
      const existing = await Room.findOne({
        hospitalId,
        room_number: body.room_number,
        _id: { $ne: req.params.id },
        is_active: { $ne: false }
      });
      if (existing) {
        return res.status(409).json({ success: false, error: `Room ${body.room_number} already exists in this hospital` });
      }
    }

    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: body },
      { new: true, runValidators: true }
    )
      .populate('Department', 'name')
      .populate('wardId', 'name code');

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

exports.patchRoomStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { status, operationalStatus } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (operationalStatus !== undefined) updates.operationalStatus = operationalStatus;

    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { $set: updates },
      { new: true, runValidators: true }
    )
      .populate('Department', 'name')
      .populate('wardId', 'name code');

    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }

    res.json({ success: true, data: room });
  } catch (e) {
    fail(res, e);
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const occupied = await Bed.exists({ hospitalId, roomId: req.params.id, status: { $in: ['Occupied', 'Reserved'] } });
    if (occupied) return res.status(409).json({ success: false, error: 'Room has occupied or reserved beds' });
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, hospitalId, is_active: { $ne: false } },
      { $set: { is_active: false, status: 'Closed', operationalStatus: 'closed', deleted_at: new Date(), deleted_by: req.user?._id || null, deletion_reason: String(req.body?.reason || 'Room archived by user').trim() } },
      { new: true }
    );
    if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
    res.json({ success: true, message: 'Room archived successfully', data: room });
  } catch (e) { fail(res, e); }
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