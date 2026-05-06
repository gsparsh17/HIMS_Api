const Staff = require('../models/Staff');
const User = require('../models/User');
const Nurse = require('../models/Nurse');
const OTStaff = require('../models/OTStaff'); // Add this line

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
      panNumber,
      shift,
      isOTStaff,
      otSpecializations,
      experienceYears,
      licenseNumber,
      qualificationDetails
    } = req.body;

    const [firstName, ...lastNameArr] = fullName.trim().split(' ');
    const lastName = lastNameArr.join(' ');
    const normalizedGender = gender?.toLowerCase();

    // Create staff record
    const staff = new Staff({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
      role,
      department,
      specialization,
      gender: normalizedGender,
      status,
      shift,
      aadharNumber,
      panNumber,
      joined_at: joiningDate || new Date()
    });
    await staff.save();

    // Create user account if password provided
    if (password) {
      const user = new User({
        name: fullName,
        email,
        phone,
        role: "staff",
        password
      });
      await user.save();
    }

    // Create OT Staff record if role is OT Staff
    if (isOTStaff || role === 'OT Staff' || role === 'OT Technician' || role === 'OT Manager') {
      const otStaff = new OTStaff({
        userId: staff._id,
        employeeId: `OT${String(staff._id).slice(-6)}`,
        designation: role,
        specializations: otSpecializations || [],
        qualification: qualificationDetails,
        experience_years: experienceYears || 0,
        license_number: licenseNumber || '',
        is_active: status === 'Active',
        joined_date: joiningDate || new Date()
      });
      await otStaff.save();
    }

    // Sync with Nurse collection if role includes nurse
    if (role && role.toLowerCase().includes('nurse')) {
      const nurse = new Nurse({
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        department_id: department || null,
        shift_id: shift || null,
        joined_at: joiningDate || new Date()
      });
      await nurse.save();
    }

    res.status(201).json({ message: 'Staff and user created', staffId: staff._id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};


// Get all staff
exports.getAllStaff = async (req, res) => {
  try {
    const staffList = await Staff.find().populate('department').populate('shift');
    res.json(staffList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get staff by ID
exports.getStaffById = async (req, res) => {
  try {
    const staff = await Staff.findById(req.params.id).populate('department').populate('shift');
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
    ).populate('department').populate('shift');

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
      'ot technician',
      'ot manager',
      'ot staff',
      'pathology staff',
      'lab technician',
      'pathologist'
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
        // Check if it's an OT related role
        if (lowerRole === 'ot technician' || lowerRole === 'ot manager' || lowerRole === 'ot staff') {
          targetRole = 'ot_staff';
        }
        // Check if it's a Pathology related role
        else if (lowerRole === 'pathology staff' || lowerRole === 'lab technician' || lowerRole === 'pathologist') {
          targetRole = 'pathology_staff';
        }
        else {
          targetRole = validRoles.includes(lowerRole) ? lowerRole : 'staff';
        }
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

    // Sync with Nurse collection if role includes nurse
    if (staff.role && staff.role.toLowerCase().includes('nurse')) {
      const Nurse = require('../models/Nurse');
      await Nurse.findOneAndUpdate(
        { email: staff.email },
        {
          first_name: staff.first_name,
          last_name: staff.last_name,
          phone: staff.phone,
          department_id: staff.department || null,
          shift_id: staff.shift || null
        },
        { upsert: true, new: true }
      );
    }

    // Sync with OT Staff collection if role is OT related
    if (staff.role && (
      staff.role.toLowerCase().includes('ot') ||
      staff.role.toLowerCase() === 'ot technician' ||
      staff.role.toLowerCase() === 'ot manager' ||
      staff.role.toLowerCase() === 'ot staff'
    )) {
      const OTStaff = require('../models/OTStaff');

      // Check if OT Staff record exists
      let otStaff = await OTStaff.findOne({ userId: staff.user_id || staff._id });

      if (otStaff) {
        // Update existing OT Staff record
        otStaff.designation = staff.role;
        otStaff.is_active = staff.status === 'Active';
        await otStaff.save();
      } else if (staff.user_id) {
        // Create new OT Staff record
        const newOTStaff = new OTStaff({
          userId: staff.user_id,
          employeeId: `OT${String(staff._id).slice(-6)}`,
          designation: staff.role,
          specializations: staff.specializations || [],
          qualification: staff.qualificationDetails || '',
          experience_years: staff.experience_years || 0,
          is_active: staff.status === 'Active',
          joined_date: staff.joined_at || new Date()
        });
        await newOTStaff.save();
      }
    }

    // Sync with Pathology Staff collection if role is Pathology related
    if (staff.role && (
      staff.role.toLowerCase().includes('pathology') ||
      staff.role.toLowerCase() === 'lab technician' ||
      staff.role.toLowerCase() === 'pathologist'
    )) {
      const PathologyStaff = require('../models/PathologyStaff');

      // Check if Pathology Staff record exists
      let pathologyStaff = await PathologyStaff.findOne({
        $or: [
          { userId: staff.user_id || staff._id },
          { email: staff.email }
        ]
      });

      if (pathologyStaff) {
        // Update existing Pathology Staff record
        pathologyStaff.designation = staff.role;
        pathologyStaff.is_active = staff.status === 'Active';
        pathologyStaff.qualification = staff.qualificationDetails || pathologyStaff.qualification;
        pathologyStaff.experience_years = staff.experience_years || pathologyStaff.experience_years;
        await pathologyStaff.save();
      } else if (staff.user_id) {
        // Create new Pathology Staff record
        const newPathologyStaff = new PathologyStaff({
          userId: staff.user_id,
          employeeId: `PL${String(staff._id).slice(-6)}`,
          designation: staff.role,
          specialization: staff.specializations?.[0] || '',
          qualification: staff.qualificationDetails || '',
          experience_years: staff.experience_years || 0,
          license_number: staff.license_number || '',
          is_active: staff.status === 'Active',
          joined_date: staff.joined_at || new Date()
        });
        await newPathologyStaff.save();
      }
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
