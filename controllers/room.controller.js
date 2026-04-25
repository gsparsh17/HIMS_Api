const Room = require('../models/Room');

exports.createRoom = async (req, res) => {
  try {
    const { room_number, wardId, type, Department, status, assigned_patient_id, floor, description } = req.body;
    
    const room = new Room({
      room_number,
      wardId: wardId || null,
      type: type || 'General',
      Department: Department || null,
      status: status || 'Available',
      assigned_patient_id: assigned_patient_id || null,
      floor: floor || '',
      description: description || ''
    });
    
    await room.save();
    res.status(201).json(room);
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getAllRooms = async (req, res) => {
  try {
    const rooms = await Room.find()
      .populate('assigned_patient_id', 'first_name last_name patientId')
      .populate('Department', 'name')
      .populate('wardId', 'name code');
    res.json(rooms);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const room = await Room.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  } catch (err) {
    console.error('Error updating room:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    const room = await Room.findByIdAndDelete(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ message: 'Room deleted successfully' });
  } catch (err) {
    console.error('Error deleting room:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getRoomById = async (req, res) => {
  try {
    const room = await Room.findById(req.params.id)
      .populate('assigned_patient_id', 'first_name last_name patientId')
      .populate('Department', 'name')
      .populate('wardId', 'name code');
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  } catch (err) {
    console.error('Error fetching room:', err);
    res.status(500).json({ error: err.message });
  }
};