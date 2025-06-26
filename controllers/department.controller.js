const Department = require('../models/Department');

exports.createDepartment = async (req, res) => {
  try {
    const dept = new Department(req.body);
    await dept.save();
    res.status(201).json(dept);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllDepartments = async (req, res) => {
  try {
    const depts = await Department.find().populate('head_doctor_id');
    res.json(depts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDepartmentById = async (req, res) => {
  try {
    const dept = await Department.findById(req.params.id).populate('head_doctor_id');
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    res.json(dept);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const dept = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    res.json(dept);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllHods = async (req, res) => {
  try {
    // Get departments with head doctors populated
    const departments = await Department.find({ head_doctor_id: { $ne: null } }).populate('head_doctor_id');

    // Extract unique head doctors
    const hodsMap = new Map();
    departments.forEach(dept => {
      if (dept.head_doctor_id && !hodsMap.has(dept.head_doctor_id._id.toString())) {
        hodsMap.set(dept.head_doctor_id._id.toString(), dept.head_doctor_id);
      }
    });

    const uniqueHods = Array.from(hodsMap.values());

    res.json(uniqueHods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


exports.deleteDepartment = async (req, res) => {
  try {
    const dept = await Department.findByIdAndDelete(req.params.id);
    res.json({ message: 'Department deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDepartmentsByHeadDoctor = async (req, res) => {
  try {
    const depts = await Department.find({ head_doctor_id: req.params.headDoctorId });
    res.json(depts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};