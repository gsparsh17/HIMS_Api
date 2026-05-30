const Staff = require('../models/Staff');
const User = require('../models/User');
const Nurse = require('../models/Nurse');
const OTStaff = require('../models/OTStaff');

const VALID_USER_ROLES = new Set([
  'mediqliq_super_admin',
  'admin',
  'doctor',
  'nurse',
  'staff',
  'patient',
  'pharmacy',
  'registrar',
  'receptionist',
  'pathology_staff',
  'radiology_staff',
  'ot_staff',
  'demo',
  'hr',
  'hr_manager',
  'store',
  'store_manager',
  'inventory_manager',
  'accountant',
  'equipment_manager'
]);

const normalizeRole = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ');

const normalizeExplicitUserRole = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
    .replace(/\s+/g, '_');

const mapStaffRoleToUserRole = (staffRole, explicitUserRole) => {
  const explicit = normalizeExplicitUserRole(explicitUserRole);

  if (explicit === 'hr' || explicit === 'hr_manager') {
    return 'hr';
  }

  if (
    explicit === 'store' ||
    explicit === 'store_manager' ||
    explicit === 'inventory_manager'
  ) {
    return 'store_manager';
  }

  if (explicit === 'equipment_manager') {
    return 'equipment_manager';
  }

  if (explicit && VALID_USER_ROLES.has(explicit)) {
    return explicit;
  }

  const role = normalizeRole(staffRole);

  if (!role) return 'staff';

  if (
    role === 'hr' ||
    role === 'hr manager' ||
    role === 'human resource' ||
    role === 'human resources' ||
    role === 'human resource manager' ||
    role === 'human resources manager'
  ) {
    return 'hr';
  }

  if (
    role === 'equipment' ||
    role === 'equipment manager' ||
    role === 'asset manager'
  ) {
    return 'equipment_manager';
  }

  if (
    role === 'store' ||
    role === 'store staff' ||
    role === 'store manager' ||
    role === 'inventory manager'
  ) {
    return 'store_manager';
  }

  if (
    role === 'ot staff' ||
    role === 'ot technician' ||
    role === 'ot manager' ||
    role === 'ot nurse' ||
    role === 'surgical assistant' ||
    role.includes('ot')
  ) {
    return 'ot_staff';
  }

  if (
    role === 'pathology staff' ||
    role === 'lab technician' ||
    role === 'pathologist' ||
    role.includes('pathology')
  ) {
    return 'pathology_staff';
  }

  if (
    role === 'radiology staff' ||
    role === 'radiologist' ||
    role === 'xray technician' ||
    role === 'x ray technician' ||
    role.includes('radiology')
  ) {
    return 'radiology_staff';
  }

  if (role.includes('nurse')) {
    return 'nurse';
  }

  if (role === 'registrar') {
    return 'registrar';
  }

  if (role === 'receptionist') {
    return 'receptionist';
  }

  if (role === 'accountant') {
    return 'accountant';
  }

  if (
    role === 'pharmacy' ||
    role === 'pharmacist'
  ) {
    return 'pharmacy';
  }

  return 'staff';
};

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
      qualificationDetails,
      userRole,
      user_role
    } = req.body;

    if (!fullName || !String(fullName).trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    if (password && !email) {
      return res.status(400).json({ error: 'Email is required to create login credentials' });
    }

    const [firstName, ...lastNameArr] = fullName.trim().split(' ');
    const lastName = lastNameArr.join(' ');
    const normalizedGender = gender?.toLowerCase();

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

    if (password) {
      const targetUserRole = mapStaffRoleToUserRole(role, userRole || user_role);

      let user = await User.findOne({ email });

      if (user) {
        user.name = fullName;
        user.phone = phone;
        user.role = targetUserRole;
        user.password = password;
        user.is_active = status ? status === 'Active' : true;

        if (req.user?.hospital_id && !user.hospital_id) {
          user.hospital_id = req.user.hospital_id;
        }

        await user.save();
      } else {
        user = new User({
          name: fullName,
          email,
          phone,
          role: targetUserRole,
          password,
          hospital_id: req.user?.hospital_id || undefined,
          is_active: status ? status === 'Active' : true
        });

        await user.save();
      }

      staff.user_id = user._id;
      await staff.save();
    }

    if (
      isOTStaff ||
      role === 'OT Staff' ||
      role === 'OT Technician' ||
      role === 'OT Manager'
    ) {
      const otStaff = new OTStaff({
        userId: staff.user_id || staff._id,
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

    res.status(201).json({
      message: 'Staff and user created',
      staffId: staff._id
    });
  } catch (err) {
    console.error('Create staff error:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.getAllStaff = async (req, res) => {
  try {
    const staffList = await Staff.find()
      .populate('department')
      .populate('shift');

    res.json(staffList);
  } catch (err) {
    console.error('Get all staff error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getStaffById = async (req, res) => {
  try {
    const staff = await Staff.findById(req.params.id)
      .populate('department')
      .populate('shift');

    if (!staff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json(staff);
  } catch (err) {
    console.error('Get staff by ID error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      password,
      userRole,
      user_role,
      ...otherFields
    } = req.body;

    const updateData = { ...otherFields };

    if (fullName) {
      const [firstName, ...lastNameArr] = fullName.trim().split(' ');
      updateData.first_name = firstName;
      updateData.last_name = lastNameArr.join(' ');
    }

    if (email) updateData.email = email;
    if (phone) updateData.phone = phone;

    const staff = await Staff.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('department')
      .populate('shift');

    if (!staff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    if (password) {
      const staffEmail = email || staff.email;
      const staffPhone = phone || staff.phone;
      const staffName = fullName || `${staff.first_name || ''} ${staff.last_name || ''}`.trim();

      if (!staffEmail) {
        return res.status(400).json({ error: 'Email is required to create login credentials' });
      }

      let existingUser = null;

      if (staff.user_id) {
        existingUser = await User.findById(staff.user_id);
      }

      if (!existingUser) {
        existingUser = await User.findOne({ email: staffEmail });
      }

      const targetRole = mapStaffRoleToUserRole(staff.role, userRole || user_role);

      if (existingUser) {
        existingUser.password = password;
        existingUser.name = staffName;
        existingUser.email = staffEmail;
        existingUser.phone = staffPhone;
        existingUser.role = targetRole;
        existingUser.is_active = staff.status ? staff.status === 'Active' : true;

        if (req.user?.hospital_id && !existingUser.hospital_id) {
          existingUser.hospital_id = req.user.hospital_id;
        }

        await existingUser.save();

        staff.user_id = existingUser._id;
      } else {
        const newUser = new User({
          name: staffName,
          email: staffEmail,
          phone: staffPhone,
          role: targetRole,
          password,
          hospital_id: req.user?.hospital_id || undefined,
          is_active: staff.status ? staff.status === 'Active' : true
        });

        await newUser.save();

        staff.user_id = newUser._id;
      }

      await staff.save();
    }

    if (staff.role && staff.role.toLowerCase().includes('nurse')) {
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

    if (
      staff.role &&
      (
        staff.role.toLowerCase().includes('ot') ||
        staff.role.toLowerCase() === 'ot technician' ||
        staff.role.toLowerCase() === 'ot manager' ||
        staff.role.toLowerCase() === 'ot staff'
      )
    ) {
      let otStaff = await OTStaff.findOne({
        userId: staff.user_id || staff._id
      });

      if (otStaff) {
        otStaff.designation = staff.role;
        otStaff.is_active = staff.status === 'Active';
        await otStaff.save();
      } else if (staff.user_id) {
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

    if (
      staff.role &&
      (
        staff.role.toLowerCase().includes('pathology') ||
        staff.role.toLowerCase() === 'lab technician' ||
        staff.role.toLowerCase() === 'pathologist'
      )
    ) {
      const PathologyStaff = require('../models/PathologyStaff');

      let pathologyStaff = await PathologyStaff.findOne({
        $or: [
          { userId: staff.user_id || staff._id },
          { email: staff.email }
        ]
      });

      if (pathologyStaff) {
        pathologyStaff.designation = staff.role;
        pathologyStaff.is_active = staff.status === 'Active';
        pathologyStaff.qualification = staff.qualificationDetails || pathologyStaff.qualification;
        pathologyStaff.experience_years = staff.experience_years || pathologyStaff.experience_years;
        await pathologyStaff.save();
      } else if (staff.user_id) {
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

    res.json({
      message: 'Staff updated successfully',
      staff
    });
  } catch (err) {
    console.error('Update staff error:', err);
    res.status(400).json({ error: err.message });
  }
};

exports.deleteStaff = async (req, res) => {
  try {
    const staff = await Staff.findByIdAndDelete(req.params.id);

    if (!staff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({ message: 'Staff member deleted successfully' });
  } catch (err) {
    console.error('Delete staff error:', err);
    res.status(500).json({ error: err.message });
  }
};