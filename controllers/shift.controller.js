const Shift = require('../models/Shift');

exports.createShift = async (req, res) => {
  try {
    const shift = new Shift(req.body);
    await shift.save();
    res.status(201).json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllShifts = async (req, res) => {
  try {
    const shifts = await Shift.find();
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateShift = async (req, res) => {
  try {
    const shift = await Shift.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    await Shift.findByIdAndDelete(req.params.id);
    res.json({ message: 'Shift deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getShiftById = async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};