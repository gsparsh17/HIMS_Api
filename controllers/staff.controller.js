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
      aadharNumber,
      panNumber
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
      aadharNumber,
      panNumber,
      joined_at: joiningDate || new Date()
    });
    await staff.save();

    if(password) {
    const user = new User({
      name: fullName,
      email,
      phone,
      role: "staff",
      password
    });
    await user.save();
    }
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
    const staff = await Staff.findById(req.params.id);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update staff member
// exports.updateStaff = async (req, res) => {
//   try {
//     const staff = await Staff.findByIdAndUpdate(req.params.id, req.body, { new: true });
//     if (!staff) return res.status(404).json({ error: 'Staff not found' });
//     res.json(staff);
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

// Update staff member
// Update staff member
exports.updateStaff = async (req, res) => {
  try {
    const { fullName, email, phone, password, ...otherFields } = req.body;
    
    // Prepare update data for Staff
    const updateData = { ...otherFields };
    
    // Handle fullName split into first_name and last_name if provided
    if (fullName) {
      const [firstName, ...lastNameArr] = fullName.trim().split(' ');
      updateData.first_name = firstName;
      updateData.last_name = lastNameArr.join(' ');
    }
    
    // Update email and phone if provided
    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;

    const staff = await Staff.findByIdAndUpdate(
      req.params.id, 
      updateData, 
      { new: true, runValidators: true }
    );

    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    const validRoles = [
      'nurse',
      'wardboy', 
      'registrar',
      'lab technician',
      'radiologist',
      'surgeon',
      'anesthesiologist',
      'accountant',
      'cleaner',
      'security',
      'ambulance driver',
      'hr',
      'staff',
      'receptionist',
      'it support',
      'others',
    ];

    // If password is provided, attempt to create or update the User account
    if (password) {
      const staffEmail = email || staff.email;
      const staffPhone = phone || staff.phone;
      const staffName = fullName || `${staff.first_name} ${staff.last_name}`.trim();
      
      const existingUser = await User.findOne({ email: staffEmail });
      let targetRole = 'staff';
      
      if (staff.role) {
        const lowerRole = staff.role.toLowerCase();
        targetRole = validRoles.includes(lowerRole) ? lowerRole : 'staff';
      }

      if (existingUser) {
        // Update existing user
        existingUser.password = password;
        existingUser.name = staffName;
        existingUser.phone = staffPhone;
        existingUser.role = targetRole;
        await existingUser.save();
        
        // Link staff to user
        staff.user_id = existingUser._id;
      } else {
        // Create new user
        const newUser = new User({
          name: staffName,
          email: staffEmail,
          phone: staffPhone,
          role: targetRole,
          password
        });
        await newUser.save();
        
        // Link staff to user
        staff.user_id = newUser._id;
      }
      
      await staff.save();
    }

    res.json({ message: 'Staff updated successfully', staff });

  } catch (err) {
    console.error('Update staff error:', err);
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
