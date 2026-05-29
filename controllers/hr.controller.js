const generateToken = require('../utils/generateToken');
const User = require('../models/User');
const Staff = require('../models/Staff');
const Nurse = require('../models/Nurse');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const HRStaffProfile = require('../models/HRStaffProfile');
const StaffAttendance = require('../models/StaffAttendance');
const StaffAvailability = require('../models/StaffAvailability');
const StaffLeaveRequest = require('../models/StaffLeaveRequest');
const { resolveHospitalId } = require('../utils/hospitalScope');

const HR_ROLES = ['hr', 'hr_manager', 'admin', 'mediqliq_super_admin'];

function getUserId(req) {
  return req.user?._id || req.user?.id || req.body?.created_by || null;
}

const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function splitName(fullName = '') {
  const [firstName, ...last] = String(fullName).trim().split(/\s+/);
  return { firstName: firstName || '', lastName: last.join(' ') };
}

function startOfDay(value) {
  const d = value ? new Date(value) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function roleFromStaffType(staffType, designation = '') {
  const normalizedType = String(staffType || '').toLowerCase();
  const normalizedDesignation = String(designation || '').toLowerCase();

  if (normalizedType === 'doctor' || normalizedDesignation.includes('doctor')) return 'doctor';
  if (normalizedType === 'nurse' || normalizedDesignation.includes('nurse')) return 'nurse';
  if (normalizedType === 'hr' || normalizedDesignation.includes('hr')) return 'hr';
  if (normalizedType === 'store' || normalizedDesignation.includes('store') || normalizedDesignation.includes('inventory')) return 'store';
  if (normalizedType === 'pharmacy' || normalizedDesignation.includes('pharmac')) return 'pharmacy';
  if (normalizedType === 'pathology_staff' || normalizedDesignation.includes('pathology') || normalizedDesignation.includes('lab')) return 'pathology_staff';
  if (normalizedType === 'radiology_staff' || normalizedDesignation.includes('radio')) return 'radiology_staff';
  if (normalizedType === 'ot_staff' || normalizedDesignation.includes('ot ')) return 'ot_staff';
  if (normalizedType === 'receptionist' || normalizedDesignation.includes('reception')) return 'receptionist';
  if (normalizedType === 'registrar' || normalizedDesignation.includes('registrar')) return 'registrar';
  if (normalizedType === 'admin') return 'admin';
  return 'staff';
}

async function ensureDepartment(body) {
  if (body.department) return body.department;
  if (body.department_name) {
    const existing = await Department.findOne({ name: new RegExp(`^${body.department_name}$`, 'i') });
    if (existing) return existing._id;
    const created = await Department.create({ name: body.department_name });
    return created._id;
  }
  let department = await Department.findOne({ name: /^General$/i });
  if (!department) department = await Department.create({ name: 'General' });
  return department._id;
}

async function createOrUpdateUser({ body, role, existingUser }) {
  if (!body.create_login && !body.password && !existingUser) return null;
  const payload = {
    name: body.full_name || body.fullName || body.name,
    email: body.email,
    role,
    is_active: body.login_enabled !== false,
    hospital_id: body.hospital_id || undefined
  };

  if (existingUser) {
    existingUser.name = payload.name || existingUser.name;
    existingUser.role = role || existingUser.role;
    existingUser.is_active = payload.is_active;
    if (body.password) existingUser.password = body.password;
    await existingUser.save();
    return existingUser;
  }

  if (!body.password) return null;
  return User.create({ ...payload, password: body.password });
}

async function syncRoleCollections({ body, user, departmentId, profile }) {
  const fullName = body.full_name || body.fullName || body.name;
  const { firstName, lastName } = splitName(fullName);
  const staffType = String(body.staff_type || body.staffType || 'staff').toLowerCase();
  const designation = body.designation || body.role || staffType;
  let staff = null;
  let nurse = null;
  let doctor = null;

  if (staffType !== 'doctor') {
    staff = await Staff.findOneAndUpdate(
      { email: body.email },
      {
        user_id: user?._id,
        first_name: firstName,
        last_name: lastName,
        email: body.email,
        phone: body.phone || 'N/A',
        role: designation,
        department: departmentId,
        specialization: body.specialization,
        gender: body.gender,
        status: body.employment_status || 'Active',
        aadharNumber: body.aadhar_number || body.aadharNumber,
        panNumber: body.pan_number || body.panNumber,
        shift: body.shift,
        joined_at: body.joining_date || body.joiningDate || new Date()
      },
      { upsert: true, new: true, runValidators: false }
    );
  }

  if (staffType === 'nurse') {
    nurse = await Nurse.findOneAndUpdate(
      { email: body.email },
      {
        first_name: firstName,
        last_name: lastName,
        email: body.email,
        phone: body.phone || 'N/A',
        department_id: departmentId,
        shift_id: body.shift || null,
        joined_at: body.joining_date || body.joiningDate || new Date()
      },
      { upsert: true, new: true, runValidators: false }
    );
  }

  if (staffType === 'doctor') {
    const generatedLicense = body.license_number || body.licenseNumber || `LIC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    doctor = await Doctor.findOneAndUpdate(
      { email: body.email },
      {
        user_id: user?._id,
        firstName,
        lastName,
        email: body.email,
        phone: body.phone || 'N/A',
        dateOfBirth: body.date_of_birth || body.dateOfBirth,
        gender: body.gender,
        address: body.address,
        department: departmentId,
        specialization: body.specialization,
        licenseNumber: generatedLicense,
        experience: body.experience || body.experience_years || 0,
        education: body.qualification || body.education,
        shift: body.shift_name || body.shift,
        startDate: body.joining_date || body.joiningDate || new Date(),
        isFullTime: body.employment_type !== 'Part Time' && body.employment_type !== 'Visiting',
        paymentType: body.salary_type || body.paymentType || 'Salary',
        amount: toNumber(body.salary_amount || body.amount, 0),
        aadharNumber: body.aadhar_number || body.aadharNumber,
        panNumber: body.pan_number || body.panNumber,
        notes: body.notes
      },
      { upsert: true, new: true, runValidators: false }
    );
  }

  if (profile) {
    if (staff) profile.staff_id = staff._id;
    if (nurse) profile.nurse_id = nurse._id;
    if (doctor) profile.doctor_id = doctor._id;
    await profile.save();
  }

  return { staff, nurse, doctor };
}

exports.hrLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!HR_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'This account does not have HR dashboard access' });
    }

    const profile = await HRStaffProfile.findOne({ user_id: user._id });
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      dashboard: 'hr',
      token: generateToken(user._id, user.role),
      employeeId: profile?._id,
      employeeCode: profile?.employee_code
    });
  } catch (error) {
    console.error('HR login error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.createEmployee = async (req, res) => {
  try {
    const body = req.body;
    const fullName = body.full_name || body.fullName || body.name;
    if (!fullName || !body.email) return res.status(400).json({ error: 'Full name and email are required' });

    const hospitalId = await resolveHospitalId(req);
    const staffType = String(body.staff_type || body.staffType || 'staff').toLowerCase();
    const designation = body.designation || body.role || staffType;
    const userRole = body.user_role || roleFromStaffType(staffType, designation);
    const departmentId = await ensureDepartment({ ...body, department_name: body.department_name || body.departmentName });
    const existingUser = await User.findOne({ email: body.email });
    const user = await createOrUpdateUser({ body: { ...body, hospital_id: hospitalId, full_name: fullName }, role: userRole, existingUser });
    const { firstName, lastName } = splitName(fullName);

    let profile = await HRStaffProfile.findOne({ email: body.email, hospital_id: hospitalId });
    const profilePayload = {
      user_id: user?._id || existingUser?._id,
      full_name: fullName,
      first_name: firstName,
      last_name: lastName,
      email: body.email,
      phone: body.phone,
      gender: body.gender,
      date_of_birth: body.date_of_birth || body.dateOfBirth,
      address: body.address,
      staff_type: staffType,
      designation,
      department: departmentId,
      department_name: body.department_name || body.departmentName,
      specialization: body.specialization,
      qualification: body.qualification || body.education,
      license_number: body.license_number || body.licenseNumber,
      shift: body.shift,
      joining_date: body.joining_date || body.joiningDate || new Date(),
      employment_type: body.employment_type || body.employmentType || 'Full Time',
      employment_status: body.employment_status || body.status || 'Active',
      salary_type: body.salary_type || body.paymentType || 'Salary',
      salary_amount: toNumber(body.salary_amount || body.amount, 0),
      bank_name: body.bank_name,
      bank_account_number: body.bank_account_number,
      ifsc_code: body.ifsc_code,
      aadhar_number: body.aadhar_number || body.aadharNumber,
      pan_number: body.pan_number || body.panNumber,
      emergency_contact_name: body.emergency_contact_name,
      emergency_contact_phone: body.emergency_contact_phone,
      login_enabled: Boolean(user),
      availability_status: body.availability_status || 'available',
      availability_note: body.availability_note,
      hospital_id: hospitalId,
      created_by: getUserId(req),
      updated_by: getUserId(req)
    };

    if (profile) {
      Object.assign(profile, profilePayload);
      await profile.save();
    } else {
      profile = await HRStaffProfile.create(profilePayload);
    }

    const linkedRecords = await syncRoleCollections({ body: { ...body, staff_type: staffType, full_name: fullName }, user, departmentId, profile });

    await StaffAvailability.create({
      employee_id: profile._id,
      user_id: user?._id,
      status: profile.availability_status,
      note: profile.availability_note,
      hospital_id: hospitalId,
      updated_by: getUserId(req)
    });

    await profile.populate('department', 'name');
    res.status(201).json({
      message: 'Employee created successfully',
      employee: profile,
      loginCreated: Boolean(user),
      user: user ? { _id: user._id, name: user.name, email: user.email, role: user.role, is_active: user.is_active } : null,
      linkedRecords
    });
  } catch (error) {
    console.error('Create employee error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getEmployees = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.staff_type) filter.staff_type = req.query.staff_type;
    if (req.query.department) filter.department = req.query.department;
    if (req.query.status) filter.employment_status = req.query.status;
    if (req.query.availability_status) filter.availability_status = req.query.availability_status;
    if (req.query.search) {
      filter.$or = [
        { full_name: { $regex: req.query.search, $options: 'i' } },
        { employee_code: { $regex: req.query.search, $options: 'i' } },
        { email: { $regex: req.query.search, $options: 'i' } },
        { phone: { $regex: req.query.search, $options: 'i' } },
        { designation: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '50', 10)));
    const skip = (page - 1) * limit;

    const [employees, total] = await Promise.all([
      HRStaffProfile.find(filter)
        .populate('user_id', 'name email role is_active')
        .populate('department', 'name')
        .populate('shift', 'name startTime endTime')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      HRStaffProfile.countDocuments(filter)
    ]);

    res.json({ employees, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getEmployeeById = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.params.id)
      .populate('user_id', 'name email role is_active')
      .populate('department', 'name')
      .populate('shift')
      .populate('staff_id')
      .populate('doctor_id')
      .populate('nurse_id');
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const body = req.body;
    const departmentId = body.department || (body.department_name ? await ensureDepartment(body) : employee.department);
    const fullName = body.full_name || body.fullName || employee.full_name;
    const { firstName, lastName } = splitName(fullName);

    Object.assign(employee, {
      ...body,
      full_name: fullName,
      first_name: firstName,
      last_name: lastName,
      department: departmentId,
      updated_by: getUserId(req)
    });
    await employee.save();

    if (employee.user_id) {
      const user = await User.findById(employee.user_id);
      if (user) {
        user.name = employee.full_name;
        if (body.email) user.email = body.email;
        if (body.user_role) user.role = body.user_role;
        if (body.login_enabled !== undefined) user.is_active = Boolean(body.login_enabled);
        if (body.password) user.password = body.password;
        await user.save();
      }
    }

    await syncRoleCollections({ body: { ...body, full_name: employee.full_name, email: employee.email, staff_type: employee.staff_type, designation: employee.designation, phone: employee.phone }, user: employee.user_id, departmentId, profile: employee });

    await employee.populate('user_id', 'name email role is_active');
    await employee.populate('department', 'name');
    res.json({ message: 'Employee updated successfully', employee });
  } catch (error) {
    console.error('Update employee error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.setEmployeeLogin = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    let user = employee.user_id ? await User.findById(employee.user_id) : await User.findOne({ email: employee.email });
    const role = req.body.role || roleFromStaffType(employee.staff_type, employee.designation);

    if (user) {
      user.name = employee.full_name;
      user.email = employee.email;
      user.role = role;
      user.is_active = req.body.is_active !== undefined ? Boolean(req.body.is_active) : true;
      if (req.body.password) user.password = req.body.password;
      await user.save();
    } else {
      if (!req.body.password) return res.status(400).json({ error: 'Password is required to create a login' });
      user = await User.create({
        name: employee.full_name,
        email: employee.email,
        role,
        password: req.body.password,
        is_active: true,
        hospital_id: employee.hospital_id
      });
    }

    employee.user_id = user._id;
    employee.login_enabled = user.is_active;
    await employee.save();

    res.json({
      message: 'Employee login updated',
      employee,
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, is_active: user.is_active }
    });
  } catch (error) {
    console.error('Set employee login error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.deactivateEmployee = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    employee.employment_status = req.body.status || 'Inactive';
    employee.login_enabled = false;
    employee.availability_status = 'unavailable';
    await employee.save();

    if (employee.user_id) {
      await User.findByIdAndUpdate(employee.user_id, { is_active: false });
    }

    res.json({ message: 'Employee deactivated', employee });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getDashboard = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    const today = startOfDay(new Date());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

    const [
      totalEmployees,
      activeEmployees,
      doctors,
      nurses,
      staff,
      attendanceSummary,
      availabilitySummary,
      pendingLeaves,
      recentAttendance
    ] = await Promise.all([
      HRStaffProfile.countDocuments(filter),
      HRStaffProfile.countDocuments({ ...filter, employment_status: 'Active' }),
      HRStaffProfile.countDocuments({ ...filter, staff_type: 'doctor' }),
      HRStaffProfile.countDocuments({ ...filter, staff_type: 'nurse' }),
      HRStaffProfile.countDocuments({ ...filter, staff_type: { $nin: ['doctor', 'nurse'] } }),
      StaffAttendance.aggregate([
        { $match: { ...filter, attendance_date: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      HRStaffProfile.aggregate([
        { $match: filter },
        { $group: { _id: '$availability_status', count: { $sum: 1 } } }
      ]),
      StaffLeaveRequest.countDocuments({ ...filter, status: 'pending' }),
      StaffAttendance.find({ ...filter, attendance_date: { $gte: today, $lt: tomorrow } })
        .populate('employee_id', 'full_name employee_code staff_type designation availability_status')
        .sort({ updatedAt: -1 })
        .limit(10)
    ]);

    res.json({
      summary: {
        totalEmployees,
        activeEmployees,
        doctors,
        nurses,
        otherStaff: staff,
        pendingLeaves,
        todayAttendance: attendanceSummary.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {}),
        availability: availabilitySummary.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {})
      },
      recentAttendance
    });
  } catch (error) {
    console.error('HR dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.markAttendance = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id || req.params.employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const date = startOfDay(req.body.attendance_date || req.body.date);
    const checkIn = req.body.check_in ? new Date(req.body.check_in) : undefined;
    const checkOut = req.body.check_out ? new Date(req.body.check_out) : undefined;

    const attendance = await StaffAttendance.findOneAndUpdate(
      { employee_id: employee._id, attendance_date: date },
      {
        employee_id: employee._id,
        user_id: employee.user_id,
        attendance_date: date,
        check_in: checkIn,
        check_out: checkOut,
        break_minutes: toNumber(req.body.break_minutes, 0),
        status: req.body.status || 'present',
        attendance_source: req.body.attendance_source || 'hr',
        shift: req.body.shift || employee.shift,
        location: req.body.location,
        remarks: req.body.remarks,
        approved_by: getUserId(req),
        hospital_id: employee.hospital_id || await resolveHospitalId(req),
        created_by: getUserId(req),
        updated_by: getUserId(req)
      },
      { upsert: true, new: true, runValidators: true }
    ).populate('employee_id', 'full_name employee_code staff_type designation');

    res.json({ message: 'Attendance marked', attendance });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.bulkMarkAttendance = async (req, res) => {
  try {
    const records = Array.isArray(req.body.records) ? req.body.records : [];
    if (!records.length) return res.status(400).json({ error: 'records array is required' });

    const results = [];
    for (const record of records) {
      const fakeReq = { ...req, body: record };
      const employee = await HRStaffProfile.findById(record.employee_id);
      if (!employee) {
        results.push({ employee_id: record.employee_id, error: 'Employee not found' });
        continue;
      }
      const date = startOfDay(record.attendance_date || record.date);
      const attendance = await StaffAttendance.findOneAndUpdate(
        { employee_id: employee._id, attendance_date: date },
        {
          employee_id: employee._id,
          user_id: employee.user_id,
          attendance_date: date,
          check_in: record.check_in ? new Date(record.check_in) : undefined,
          check_out: record.check_out ? new Date(record.check_out) : undefined,
          break_minutes: toNumber(record.break_minutes, 0),
          status: record.status || 'present',
          attendance_source: record.attendance_source || 'hr',
          shift: record.shift || employee.shift,
          location: record.location,
          remarks: record.remarks,
          approved_by: getUserId(req),
          hospital_id: employee.hospital_id || await resolveHospitalId(fakeReq),
          created_by: getUserId(req),
          updated_by: getUserId(req)
        },
        { upsert: true, new: true, runValidators: true }
      );
      results.push(attendance);
    }

    res.json({ message: 'Bulk attendance processed', results });
  } catch (error) {
    console.error('Bulk attendance error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.checkIn = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id || req.params.employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const date = startOfDay(req.body.date);
    const now = req.body.check_in ? new Date(req.body.check_in) : new Date();
    const attendance = await StaffAttendance.findOneAndUpdate(
      { employee_id: employee._id, attendance_date: date },
      {
        $setOnInsert: {
          employee_id: employee._id,
          user_id: employee.user_id,
          attendance_date: date,
          hospital_id: employee.hospital_id || await resolveHospitalId(req),
          created_by: getUserId(req)
        },
        $set: {
          check_in: now,
          status: req.body.status || 'present',
          attendance_source: req.body.attendance_source || 'self',
          location: req.body.location,
          updated_by: getUserId(req)
        }
      },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ message: 'Checked in', attendance });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.checkOut = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id || req.params.employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const date = startOfDay(req.body.date);
    const attendance = await StaffAttendance.findOne({ employee_id: employee._id, attendance_date: date });
    if (!attendance) return res.status(404).json({ error: 'Check-in record not found' });
    attendance.check_out = req.body.check_out ? new Date(req.body.check_out) : new Date();
    attendance.break_minutes = toNumber(req.body.break_minutes, attendance.break_minutes);
    attendance.remarks = req.body.remarks || attendance.remarks;
    attendance.updated_by = getUserId(req);
    await attendance.save();
    res.json({ message: 'Checked out', attendance });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getAttendance = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.startDate || req.query.endDate || req.query.date) {
      filter.attendance_date = {};
      if (req.query.date) {
        const date = startOfDay(req.query.date);
        const next = new Date(date); next.setDate(date.getDate() + 1);
        filter.attendance_date.$gte = date;
        filter.attendance_date.$lt = next;
      } else {
        if (req.query.startDate) filter.attendance_date.$gte = startOfDay(req.query.startDate);
        if (req.query.endDate) filter.attendance_date.$lte = startOfDay(req.query.endDate);
      }
    }

    const attendance = await StaffAttendance.find(filter)
      .populate('employee_id', 'full_name employee_code staff_type designation department_name availability_status')
      .populate('user_id', 'name email role')
      .sort({ attendance_date: -1, updatedAt: -1 });
    res.json(attendance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.setAvailability = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id || req.params.employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    employee.availability_status = req.body.status || req.body.availability_status || employee.availability_status;
    employee.availability_note = req.body.note || req.body.availability_note || employee.availability_note;
    await employee.save();

    const availability = await StaffAvailability.create({
      employee_id: employee._id,
      user_id: employee.user_id,
      status: employee.availability_status,
      current_location: req.body.current_location,
      valid_from: req.body.valid_from ? new Date(req.body.valid_from) : new Date(),
      valid_to: req.body.valid_to ? new Date(req.body.valid_to) : undefined,
      note: employee.availability_note,
      hospital_id: employee.hospital_id || await resolveHospitalId(req),
      updated_by: getUserId(req)
    });

    res.json({ message: 'Availability updated', employee, availability });
  } catch (error) {
    console.error('Set availability error:', error);
    res.status(400).json({ error: error.message });
  }
};

exports.getAvailability = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.status) filter.availability_status = req.query.status;
    if (req.query.staff_type) filter.staff_type = req.query.staff_type;
    if (req.query.department) filter.department = req.query.department;

    const employees = await HRStaffProfile.find(filter)
      .select('employee_code full_name staff_type designation department department_name availability_status availability_note user_id')
      .populate('department', 'name')
      .populate('user_id', 'name email role')
      .sort({ staff_type: 1, full_name: 1 });

    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.createLeaveRequest = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const leave = await StaffLeaveRequest.create({
      ...req.body,
      user_id: employee.user_id,
      hospital_id: employee.hospital_id || await resolveHospitalId(req),
      created_by: getUserId(req)
    });
    await leave.populate('employee_id', 'full_name employee_code staff_type designation');
    res.status(201).json({ message: 'Leave request created', leave });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getLeaveRequests = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;

    const leaves = await StaffLeaveRequest.find(filter)
      .populate('employee_id', 'full_name employee_code staff_type designation')
      .populate('approved_by', 'name email role')
      .sort({ createdAt: -1 });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateLeaveStatus = async (req, res) => {
  try {
    const leave = await StaffLeaveRequest.findById(req.params.id).populate('employee_id');
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });

    leave.status = req.body.status;
    leave.approved_by = getUserId(req);
    leave.approved_at = new Date();
    leave.rejection_reason = req.body.rejection_reason;
    await leave.save();

    if (req.body.status === 'approved' && leave.employee_id) {
      leave.employee_id.availability_status = 'on_leave';
      leave.employee_id.availability_note = `Leave approved from ${leave.start_date.toDateString()} to ${leave.end_date.toDateString()}`;
      await leave.employee_id.save();
    }

    res.json({ message: 'Leave status updated', leave });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
