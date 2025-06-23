const Staff = require('../models/Staff');
const User = require('../models/User');


exports.createStaff = async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      role,
      department,
      specialization,
      joiningDate,
      gender,
      status,
      password,
    } = req.body;

    // Split full name
    const [firstName, ...lastNameArr] = fullName.trim().split(' ');
    const lastName = lastNameArr.join(' ');
    const normalizedGender = gender?.toLowerCase();

    // 1. Create staff record (without password)
    const staff = new Staff({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      role,
      department,
      specialization,
      gender:normalizedGender,
      status,
      joined_at: joiningDate || new Date()
    });
    await staff.save();

    const user = new User({
      name: fullName,
      email,
      phone,
      role,
      password
    });
    await user.save();

    res.status(201).json({ message: 'Staff and user created', staffId: staff._id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


// Get all staff
exports.getAllStaff = async (req, res) => {
  try {
    const staffList = await Staff.find();
    res.json(staffList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get staff by ID
exports.getStaffById = async (req, res) => {
  try {
    const staff = await Staff.findById(req.params.id).populate('shift_id');
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update staff member
exports.updateStaff = async (req, res) => {
  try {
    const staff = await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    res.json(staff);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete staff member
exports.deleteStaff = async (req, res) => {
  try {
    const staff = await Staff.findByIdAndDelete(req.params.id);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    res.json({ message: 'Staff member deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
