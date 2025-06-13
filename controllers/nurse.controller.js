const Nurse = require('../models/Nurse');

// Create nurse
exports.createNurse = async (req, res) => {
  try {
    const nurse = new Nurse(req.body);
    await nurse.save();
    res.status(201).json(nurse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all nurses
exports.getAllNurses = async (req, res) => {
  try {
    const nurses = await Nurse.find().populate('department_id').populate('shift_id');
    res.json(nurses);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get nurse by ID
exports.getNurseById = async (req, res) => {
  try {
    const nurse = await Nurse.findById(req.params.id).populate('department_id').populate('shift_id');
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    res.json(nurse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update nurse
exports.updateNurse = async (req, res) => {
  try {
    const nurse = await Nurse.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    res.json(nurse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete nurse
exports.deleteNurse = async (req, res) => {
  try {
    const nurse = await Nurse.findByIdAndDelete(req.params.id);
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    res.json({ message: 'Nurse deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
