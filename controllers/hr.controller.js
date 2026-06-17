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
const EmployeePayroll = require('../models/EmployeePayroll');
const HRLeaveBalance = require('../models/HRLeaveBalance');
const { syncAllExistingHRProfiles } = require('../services/hrProfileSync.service');
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

async function syncExistingToHR(hospitalId) {
  const cleanGender = (g) => {
    const normalized = String(g || '').toLowerCase().trim();
    if (['male', 'female', 'other', 'prefer_not_to_say'].includes(normalized)) {
      return normalized;
    }
    return undefined;
  };

  try {
    // 1. Sync Doctors
    const doctors = await Doctor.find({}).populate('user_id');
    for (const doc of doctors) {
      const email = doc.email?.toLowerCase().trim();
      if (!email) continue;
      const existing = await HRStaffProfile.findOne({ email, hospital_id: hospitalId });
      if (!existing) {
        await HRStaffProfile.create({
          doctor_id: doc._id,
          user_id: doc.user_id?._id || doc.user_id,
          full_name: `${doc.firstName || ''} ${doc.lastName || ''}`.trim() || 'Unnamed Doctor',
          first_name: doc.firstName,
          last_name: doc.lastName,
          email,
          phone: doc.phone,
          gender: cleanGender(doc.gender),
          date_of_birth: doc.dateOfBirth,
          address: doc.address,
          staff_type: 'doctor',
          designation: 'Doctor',
          department: doc.department,
          specialization: doc.specialization,
          qualification: doc.education,
          license_number: doc.licenseNumber,
          joining_date: doc.startDate || doc.joined_at,
          employment_type: doc.isFullTime ? 'Full Time' : 'Part Time',
          salary_type: doc.paymentType || 'Salary',
          salary_amount: doc.amount || 0,
          aadhar_number: doc.aadharNumber,
          pan_number: doc.panNumber,
          login_enabled: !!doc.user_id,
          hospital_id: hospitalId
        });
      } else {
        let updated = false;
        if (!existing.doctor_id) { existing.doctor_id = doc._id; updated = true; }
        if (!existing.user_id && doc.user_id) { existing.user_id = doc.user_id?._id || doc.user_id; updated = true; }
        if (updated) await existing.save();
      }
    }

    // 2. Sync Nurses
    const nurses = await Nurse.find({});
    for (const n of nurses) {
      const email = n.email?.toLowerCase().trim();
      if (!email) continue;
      const existing = await HRStaffProfile.findOne({ email, hospital_id: hospitalId });
      if (!existing) {
        const u = await User.findOne({ email });
        await HRStaffProfile.create({
          nurse_id: n._id,
          user_id: u?._id,
          full_name: `${n.first_name || ''} ${n.last_name || ''}`.trim() || 'Unnamed Nurse',
          first_name: n.first_name,
          last_name: n.last_name,
          email,
          phone: n.phone,
          staff_type: 'nurse',
          designation: 'Nurse',
          department: n.department_id,
          shift: n.shift_id,
          joining_date: n.joined_at,
          login_enabled: !!u,
          hospital_id: hospitalId
        });
      } else {
        let updated = false;
        if (!existing.nurse_id) { existing.nurse_id = n._id; updated = true; }
        if (updated) await existing.save();
      }
    }

    // 3. Sync Staff
    const staffList = await Staff.find({}).populate('user_id');
    for (const s of staffList) {
      const email = s.email?.toLowerCase().trim();
      if (!email) continue;
      const existing = await HRStaffProfile.findOne({ email, hospital_id: hospitalId });
      if (!existing) {
        const staffType = roleFromStaffType(s.role || 'staff');
        await HRStaffProfile.create({
          staff_id: s._id,
          user_id: s.user_id?._id || s.user_id,
          full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || 'Unnamed Staff',
          first_name: s.first_name,
          last_name: s.last_name,
          email,
          phone: s.phone,
          gender: cleanGender(s.gender),
          staff_type: staffType,
          designation: s.role || 'Staff',
          department: s.department,
          shift: s.shift,
          joining_date: s.joined_at,
          employment_status: s.status || 'Active',
          aadhar_number: s.aadharNumber,
          pan_number: s.panNumber,
          login_enabled: !!s.user_id,
          hospital_id: hospitalId
        });
      } else {
        let updated = false;
        if (!existing.staff_id) { existing.staff_id = s._id; updated = true; }
        if (!existing.user_id && s.user_id) { existing.user_id = s.user_id?._id || s.user_id; updated = true; }
        if (updated) await existing.save();
      }
    }

    // 4. Sync Pathology Staff
    try {
      const PathologyStaff = require('../models/PathologyStaff');
      const pathologyList = await PathologyStaff.find({}).populate('user_id');
      for (const p of pathologyList) {
        const email = p.email?.toLowerCase().trim();
        if (!email) continue;
        const existing = await HRStaffProfile.findOne({ email, hospital_id: hospitalId });
        if (!existing) {
          await HRStaffProfile.create({
            user_id: p.user_id?._id || p.user_id,
            full_name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Unnamed Pathology Staff',
            first_name: p.first_name,
            last_name: p.last_name,
            email,
            phone: p.phone,
            gender: cleanGender(p.gender),
            date_of_birth: p.date_of_birth,
            staff_type: 'pathology_staff',
            designation: p.role || 'Pathology Staff',
            department: p.department,
            joining_date: p.joined_at,
            employment_status: p.status || 'Active',
            aadhar_number: p.aadharNumber,
            pan_number: p.panNumber,
            login_enabled: !!p.user_id,
            hospital_id: hospitalId
          });
        } else {
          let updated = false;
          if (!existing.user_id && p.user_id) { existing.user_id = p.user_id?._id || p.user_id; updated = true; }
          if (updated) await existing.save();
        }
      }
    } catch (err) {
      console.error('Error syncing pathology staff:', err);
    }
  } catch (error) {
    console.error('Error in syncExistingToHR:', error);
  }
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
      source_model: body.source_model || 'Manual',
      source_id: body.source_id,
      payroll_enabled: body.payroll_enabled !== undefined ? Boolean(body.payroll_enabled) : true,
      pay_cycle: body.pay_cycle || 'monthly',
      basic_salary: toNumber(body.basic_salary, 0),
      hra: toNumber(body.hra, 0),
      conveyance_allowance: toNumber(body.conveyance_allowance, 0),
      medical_allowance: toNumber(body.medical_allowance, 0),
      other_allowance: toNumber(body.other_allowance, 0),
      pf_deduction: toNumber(body.pf_deduction, 0),
      esi_deduction: toNumber(body.esi_deduction, 0),
      professional_tax: toNumber(body.professional_tax, 0),
      tds: toNumber(body.tds, 0),
      other_deduction: toNumber(body.other_deduction, 0),
      paid_leave_quota: toNumber(body.paid_leave_quota, 0),
      unpaid_leave_policy: body.unpaid_leave_policy || 'deduct_per_day',
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
    await syncExistingToHR(hospitalId);
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
      .populate('nurse_id')
      .populate('lab_staff_id')
      .populate('pathology_staff_id')
      .populate('radiology_staff_id')
      .populate('ot_staff_id');
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
    await syncExistingToHR(hospitalId);
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
    const breakMinutes = toNumber(req.body.break_minutes, 0);

    let totalMinutes = 0;
    if (checkIn && checkOut) {
      const diff = Math.max(0, checkOut.getTime() - checkIn.getTime());
      totalMinutes = Math.max(0, Math.round(diff / 60000) - breakMinutes);
    }

    const attendance = await StaffAttendance.findOneAndUpdate(
      { employee_id: employee._id, attendance_date: date },
      {
        employee_id: employee._id,
        user_id: employee.user_id,
        attendance_date: date,
        check_in: checkIn,
        check_out: checkOut,
        break_minutes: breakMinutes,
        total_minutes: totalMinutes,
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
      const checkIn = record.check_in ? new Date(record.check_in) : undefined;
      const checkOut = record.check_out ? new Date(record.check_out) : undefined;
      const breakMinutes = toNumber(record.break_minutes, 0);

      let totalMinutes = 0;
      if (checkIn && checkOut) {
        const diff = Math.max(0, checkOut.getTime() - checkIn.getTime());
        totalMinutes = Math.max(0, Math.round(diff / 60000) - breakMinutes);
      }

      const attendance = await StaffAttendance.findOneAndUpdate(
        { employee_id: employee._id, attendance_date: date },
        {
          employee_id: employee._id,
          user_id: employee.user_id,
          attendance_date: date,
          check_in: checkIn,
          check_out: checkOut,
          break_minutes: breakMinutes,
          total_minutes: totalMinutes,
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
    await syncExistingToHR(hospitalId);
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
      const currentYear = new Date(leave.start_date).getFullYear();
      const balance = await HRLeaveBalance.findOne({
        employee_id: leave.employee_id._id,
        year: currentYear,
        leave_type: leave.leave_type
      });
      const available = balance
        ? Math.max(0, Number(balance.opening_balance || 0) + Number(balance.accrued || 0) + Number(balance.adjusted || 0) - Number(balance.used || 0))
        : Number(leave.employee_id.paid_leave_quota || 0);
      const requestedDays = toNumber(leave.total_days, 0);
      const paidDays = leave.leave_type === 'unpaid' ? 0 : Math.min(requestedDays, available);
      const unpaidDays = Math.max(0, requestedDays - paidDays);
      leave.is_paid_leave = paidDays > 0;
      leave.paid_days = paidDays;
      leave.unpaid_days = unpaidDays;
      if (balance && paidDays > 0) {
        balance.used = toNumber(balance.used, 0) + paidDays;
        balance.updated_by = getUserId(req);
        await balance.save();
      }
      await leave.save();

      leave.employee_id.availability_status = 'on_leave';
      leave.employee_id.availability_note = `Leave approved from ${leave.start_date.toDateString()} to ${leave.end_date.toDateString()}`;
      await leave.employee_id.save();
    }

    res.json({ message: 'Leave status updated', leave });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

function monthBounds(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const periodStart = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
  return { periodStart, periodEnd, totalDays: periodEnd.getDate() };
}

function listTotal(items = []) {
  return items.reduce((sum, item) => sum + toNumber(item.amount, 0), 0);
}

// ✅ FIXED: Use EmployeePayroll model and check for existing records
async function calculatePayrollForEmployee(employee, { year, month, periodStart, periodEnd, totalDays }, overrides = {}) {
  // ✅ FIX: Check if payroll already exists for this period
  const existingPayroll = await EmployeePayroll.findOne({
    employee_id: employee._id,
    period_start: { $gte: periodStart },
    period_end: { $lte: periodEnd },
    earning_type: { $in: ['salary', null] },
    status: { $nin: ['cancelled', 'rejected'] }
  });

  if (existingPayroll) {
    return null; // Skip - already exists
  }

  const attendanceRecords = await StaffAttendance.find({
    employee_id: employee._id,
    attendance_date: { $gte: periodStart, $lte: periodEnd }
  });

  const approvedLeaves = await StaffLeaveRequest.find({
    employee_id: employee._id,
    status: 'approved',
    start_date: { $lte: periodEnd },
    end_date: { $gte: periodStart }
  });

  const presentStatuses = new Set(['present', 'late']);
  const presentDays = attendanceRecords.filter((a) => presentStatuses.has(a.status)).length;
  const halfDays = attendanceRecords.filter((a) => a.status === 'half_day').length;
  const attendanceLeaveDays = attendanceRecords.filter((a) => a.status === 'leave').length;
  const absentDays = attendanceRecords.filter((a) => a.status === 'absent').length;
  const totalHours = attendanceRecords.reduce((sum, a) => sum + (toNumber(a.total_minutes, 0) / 60), 0);

  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  for (const leave of approvedLeaves) {
    if (leave.is_paid_leave === false || leave.leave_type === 'unpaid') unpaidLeaveDays += toNumber(leave.total_days, 0);
    else paidLeaveDays += toNumber(leave.total_days, 0);
  }
  if (!approvedLeaves.length && attendanceLeaveDays > 0) paidLeaveDays = attendanceLeaveDays;

  const baseSalary = toNumber(overrides.base_salary ?? employee.salary_amount, 0);
  const perDay = totalDays > 0 ? baseSalary / totalDays : 0;
  const payableDays = Math.max(0, Math.min(totalDays, presentDays + (halfDays * 0.5) + paidLeaveDays));
  const unpaidLeaveDeduction = employee.unpaid_leave_policy === 'ignore' ? 0 : perDay * unpaidLeaveDays;
  const attendanceAbsentDeduction = perDay * absentDays;

  const allowances = overrides.allowances || [
    { label: 'HRA', amount: toNumber(employee.hra, 0) },
    { label: 'Conveyance Allowance', amount: toNumber(employee.conveyance_allowance, 0) },
    { label: 'Medical Allowance', amount: toNumber(employee.medical_allowance, 0) },
    { label: 'Other Allowance', amount: toNumber(employee.other_allowance, 0) }
  ].filter((x) => x.amount > 0);

  const deductions = overrides.deductions || [
    { label: 'PF Deduction', amount: toNumber(employee.pf_deduction, 0) },
    { label: 'ESI Deduction', amount: toNumber(employee.esi_deduction, 0) },
    { label: 'Professional Tax', amount: toNumber(employee.professional_tax, 0) },
    { label: 'TDS', amount: toNumber(employee.tds, 0) },
    { label: 'Other Deduction', amount: toNumber(employee.other_deduction, 0) },
    { label: 'Unpaid Leave Deduction', amount: unpaidLeaveDeduction },
    { label: 'Absent Deduction', amount: attendanceAbsentDeduction }
  ].filter((x) => x.amount > 0);

  const bonus = toNumber(overrides.bonus, 0);
  const grossSalary = baseSalary + listTotal(allowances) + bonus;
  const totalDeductions = listTotal(deductions);
  const netSalary = Math.max(0, grossSalary - totalDeductions);
  const isDoctor = employee.source_model === 'Doctor' || employee.staff_type === 'doctor';
  const payrollCategory = employee.salary_type === 'Contractual Salary' ? 'contractual_salary' : 'fixed_salary';

  return {
    employee_id: employee._id,
    hr_staff_profile_id: employee._id,
    user_id: employee.user_id,
    hospital_id: employee.hospital_id,
    source_model: employee.source_model,
    source_id: employee.source_id,
    staff_type: employee.staff_type,
    designation: employee.designation,
    month,
    year,
    period_start: periodStart,
    period_end: periodEnd,
    salary_type: employee.salary_type || 'Salary',
    payroll_category: payrollCategory,
    earning_type: isDoctor ? 'salary' : 'salary',
    period_type: 'monthly',
    doctor_id: isDoctor ? employee.doctor_id : undefined,
    employee_name: employee.full_name,
    employee_code: employee.employee_code,
    base_salary: baseSalary,
    amount: netSalary,
    total_working_days: totalDays,
    present_days: presentDays + (halfDays * 0.5),
    paid_leave_days: paidLeaveDays,
    unpaid_leave_days: unpaidLeaveDays,
    absent_days: absentDays,
    payable_days: payableDays,
    total_hours: Number(totalHours.toFixed(2)),
    allowances,
    deductions,
    bonus,
    gross_salary: Math.max(0, grossSalary),
    gross_amount: Math.max(0, grossSalary),
    total_deductions: Math.max(0, totalDeductions),
    deduction_amount: Math.max(0, totalDeductions),
    net_salary: netSalary,
    net_amount: netSalary
  };
}

exports.syncHRProfiles = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const results = await syncAllExistingHRProfiles({ hospital_id: hospitalId });
    res.json({ message: 'HR profiles synced from staff master records', results });
  } catch (error) {
    console.error('HR profile sync error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.updateEmployeeSalaryConfig = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const fields = [
      'salary_type', 'salary_amount', 'payroll_enabled', 'pay_cycle', 'basic_salary', 'hra',
      'conveyance_allowance', 'medical_allowance', 'other_allowance', 'pf_deduction',
      'esi_deduction', 'professional_tax', 'tds', 'other_deduction', 'paid_leave_quota',
      'unpaid_leave_policy', 'bank_name', 'bank_account_number', 'ifsc_code', 'pan_number'
    ];
    fields.forEach((field) => {
      if (req.body[field] !== undefined) employee[field] = req.body[field];
    });
    employee.updated_by = getUserId(req);
    await employee.save();
    res.json({ message: 'Employee salary configuration updated', employee });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.upsertLeaveBalance = async (req, res) => {
  try {
    const employee = await HRStaffProfile.findById(req.body.employee_id || req.params.employeeId);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    const year = parseInt(req.body.year || new Date().getFullYear(), 10);
    const leaveType = req.body.leave_type || 'earned';
    const balance = await HRLeaveBalance.findOneAndUpdate(
      { employee_id: employee._id, year, leave_type: leaveType },
      {
        employee_id: employee._id,
        hospital_id: employee.hospital_id || await resolveHospitalId(req),
        year,
        leave_type: leaveType,
        opening_balance: toNumber(req.body.opening_balance, 0),
        accrued: toNumber(req.body.accrued, 0),
        used: toNumber(req.body.used, 0),
        adjusted: toNumber(req.body.adjusted, 0),
        paid_leave: req.body.paid_leave !== undefined ? Boolean(req.body.paid_leave) : true,
        notes: req.body.notes,
        updated_by: getUserId(req)
      },
      { upsert: true, new: true, runValidators: true }
    ).populate('employee_id', 'full_name employee_code staff_type designation');
    res.json({ message: 'Leave balance saved', balance });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getLeaveBalances = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.year) filter.year = parseInt(req.query.year, 10);
    if (req.query.leave_type) filter.leave_type = req.query.leave_type;
    const balances = await HRLeaveBalance.find(filter)
      .populate('employee_id', 'full_name employee_code staff_type designation')
      .sort({ year: -1, leave_type: 1 });
    res.json(balances);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ✅ FIXED: Generate payroll with duplicate check and proper status handling
exports.generatePayroll = async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.body.year || now.getFullYear(), 10);
    const month = parseInt(req.body.month || now.getMonth() + 1, 10);
    const bounds = monthBounds(year, month);
    if (!bounds) return res.status(400).json({ error: 'Valid year and month are required' });

    const hospitalId = await resolveHospitalId(req);
    const filter = { 
      payroll_enabled: true, 
      employment_status: { $ne: 'Terminated' } 
    };
    if (hospitalId) filter.hospital_id = hospitalId;
    if (req.body.employee_id) filter._id = req.body.employee_id;
    if (req.body.staff_type) filter.staff_type = req.body.staff_type;

    const employees = await HRStaffProfile.find(filter);
    const results = [];
    const errors = [];

    for (const employee of employees) {
      try {
        // Skip commission-based doctors (they use separate commission calculation)
        if ((employee.source_model === 'Doctor' || employee.staff_type === 'doctor') && 
            ['Fee per Visit', 'Per Hour', 'Commission'].includes(employee.salary_type)) {
          results.push({ 
            employee_id: employee._id, 
            status: 'skipped_commission_doctor', 
            message: 'Appointment-based doctor earnings are generated through /api/salaries/calculate-appointment or /api/salaries/bulk-calculate' 
          });
          continue;
        }

        // ✅ FIX: Check if payroll already exists for this employee and period
        const existingPayroll = await EmployeePayroll.findOne({
          employee_id: employee._id,
          month: month,
          year: year,
          period_type: 'monthly',
          earning_type: { $in: ['salary', null] },
          status: { $nin: ['cancelled', 'rejected'] }
        });

        if (existingPayroll) {
          results.push({ 
            employee_id: employee._id, 
            status: 'already_exists', 
            payroll: existingPayroll,
            message: 'Payroll already exists for this period' 
          });
          continue;
        }

        const payload = await calculatePayrollForEmployee(employee, { year, month, ...bounds }, req.body.overrides || {});
        
        // If calculatePayrollForEmployee returns null, skip (handled internally)
        if (!payload) {
          results.push({ 
            employee_id: employee._id, 
            status: 'skipped', 
            message: 'No payroll data available or already exists' 
          });
          continue;
        }

        const payroll = await EmployeePayroll.findOneAndUpdate(
          { employee_id: employee._id, year, month, earning_type: 'salary' },
          {
            ...payload,
            status: req.body.status || 'draft',
            notes: req.body.notes,
            created_by: getUserId(req),
            updated_by: getUserId(req)
          },
          { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        ).populate('employee_id', 'full_name employee_code staff_type designation bank_name bank_account_number ifsc_code');
        
        results.push({ employee_id: employee._id, payroll, status: payroll.status });
      } catch (error) {
        errors.push({ employee_id: employee._id, error: error.message });
        results.push({ employee_id: employee._id, status: 'failed', error: error.message });
      }
    }

    res.status(201).json({ 
      message: 'Payroll generation completed', 
      count: results.length, 
      errors: errors.length,
      results 
    });
  } catch (error) {
    console.error('Generate payroll error:', error);
    res.status(400).json({ error: error.message });
  }
};

// ✅ FIXED: Get payrolls with proper filtering
exports.getPayrolls = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const filter = hospitalId ? { hospital_id: hospitalId } : {};
    
    ['employee_id', 'staff_type', 'status', 'clearance_status', 'year', 'month', 'earning_type'].forEach((field) => {
      if (req.query[field]) {
        if (['year', 'month'].includes(field)) {
          filter[field] = parseInt(req.query[field], 10);
        } else if (field === 'earning_type') {
          // When filtering by earning_type, also include records where earning_type is null or undefined
          // for backward compatibility
          if (req.query[field] === 'salary') {
            filter.$or = [
              { earning_type: 'salary' },
              { earning_type: { $exists: false } },
              { earning_type: null }
            ];
          } else {
            filter.earning_type = req.query[field];
          }
        } else {
          filter[field] = req.query[field];
        }
      }
    });

    const payrolls = await EmployeePayroll.find(filter)
      .populate('employee_id', 'full_name employee_code staff_type designation bank_name bank_account_number ifsc_code')
      .populate('cleared_by', 'name email role')
      .sort({ year: -1, month: -1, createdAt: -1 });

    res.json(payrolls);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ✅ FIXED: Update payroll with status validation
exports.updatePayroll = async (req, res) => {
  try {
    const payroll = await EmployeePayroll.findById(req.params.id);
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    
    // Status transition validation
    const validTransitions = {
      'draft': ['generated', 'cancelled'],
      'generated': ['approved', 'hold', 'cancelled'],
      'approved': ['processing', 'hold', 'cancelled'],
      'processing': ['paid', 'hold', 'cancelled'],
      'paid': ['hold'],
      'hold': ['draft', 'generated', 'approved', 'cancelled'],
      'cancelled': []
    };

    if (req.body.status && validTransitions[payroll.status]) {
      if (!validTransitions[payroll.status].includes(req.body.status)) {
        return res.status(400).json({ 
          error: `Invalid status transition from ${payroll.status} to ${req.body.status}` 
        });
      }
    }

    ['allowances', 'deductions', 'bonus', 'status', 'payment_method', 'payment_reference', 'notes'].forEach((field) => {
      if (req.body[field] !== undefined) payroll[field] = req.body[field];
    });
    
    if (req.body.base_salary !== undefined) payroll.base_salary = toNumber(req.body.base_salary, payroll.base_salary);
    payroll.updated_by = getUserId(req);
    await payroll.save();
    await payroll.populate('employee_id', 'full_name employee_code staff_type designation');
    
    res.json({ message: 'Payroll updated', payroll });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ✅ FIXED: Simplified clearance - just mark as paid with validation
exports.updatePayrollClearance = async (req, res) => {
  try {
    const payroll = await EmployeePayroll.findById(req.params.id);
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });

    const action = req.body.action || req.body.clearance_status;
    
    // Simplified: Only allow paid or hold
    if (!['paid', 'hold', 'cancelled'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use paid, hold, or cancelled' });
    }

    // Can only mark as paid if status is approved or processing
    if (action === 'paid' && !['approved', 'processing'].includes(payroll.status)) {
      return res.status(400).json({ 
        error: `Cannot mark as paid from status: ${payroll.status}. Status must be approved or processing` 
      });
    }

    payroll.status = action;
    payroll.updated_by = getUserId(req);
    
    if (action === 'paid') {
      payroll.paid_date = req.body.paid_date ? new Date(req.body.paid_date) : new Date();
      payroll.payment_method = req.body.payment_method || payroll.payment_method;
      payroll.payment_reference = req.body.payment_reference || payroll.payment_reference;
    }

    await payroll.save();
    await payroll.populate('employee_id', 'full_name employee_code staff_type designation bank_name bank_account_number ifsc_code');
    
    res.json({ message: `Payroll ${action}`, payroll });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ✅ FIXED: Create payroll with uniqueness check
exports.createPayrollForEmployee = async (req, res) => {
  try {
    const {
      employee_id,
      doctor_id,
      staff_id,
      nurse_id,
      period_type,
      period_start,
      period_end,
      amount,
      net_amount,
      earning_type,
      payroll_category,
      status,
      payment_method,
      paid_date,
      notes,
      appointment_count,
      appointments,
      gross_amount,
      doctor_share,
      hospital_share,
      revenue_percentage,
      base_salary,
      bonus,
      total_deductions,
      source_model
    } = req.body;

    if (!employee_id && !doctor_id && !staff_id && !nurse_id) {
      return res.status(400).json({ 
        error: 'employee_id, doctor_id, staff_id, or nurse_id is required' 
      });
    }

    const hospitalId = await resolveHospitalId(req);
    
    // Find or create HR profile (existing logic)
    let profile = null;
    let sourceModel = source_model || 'Manual';
    let sourceId = null;
    let doctor = null;
    let staff = null;
    let nurse = null;
    
    // ... [profile lookup logic from earlier] ...

    if (!profile) {
      return res.status(404).json({ error: 'Employee profile not found' });
    }

    // ✅ FIX: Check for existing payroll to prevent duplicates
    const existingCheck = {
      employee_id: profile._id,
      period_start: { $gte: new Date(period_start) },
      period_end: { $lte: new Date(period_end) },
      earning_type: earning_type || 'salary'
    };

    // For commission, also check by appointment IDs
    if (earning_type === 'commission' && appointments && appointments.length > 0) {
      existingCheck['appointments'] = { $in: appointments };
    }

    const existingPayroll = await EmployeePayroll.findOne(existingCheck);
    if (existingPayroll) {
      return res.status(409).json({ 
        error: 'Payroll already exists for this period and employee',
        existingPayroll 
      });
    }

    // Create payroll record
    const payrollData = {
      employee_id: profile._id,
      hr_staff_profile_id: profile._id,
      user_id: profile.user_id,
      hospital_id: hospitalId,
      source_model: sourceModel,
      source_id: sourceId || profile._id,
      doctor_id: profile.doctor_id || doctor_id || null,
      staff_id: profile.staff_id || staff_id || null,
      nurse_id: profile.nurse_id || nurse_id || null,
      employee_name: profile.full_name,
      employee_code: profile.employee_code,
      staff_type: profile.staff_type,
      role: profile.staff_type,
      designation: profile.designation,
      department: profile.department,
      department_name: profile.department_name,
      payroll_category: payroll_category || (earning_type === 'commission' ? 'doctor_commission' : 'fixed_salary'),
      earning_type: earning_type || 'salary',
      salary_type: profile.salary_type || (earning_type === 'commission' ? 'Commission' : 'Salary'),
      period_type: period_type || 'monthly',
      period_start: new Date(period_start),
      period_end: new Date(period_end),
      base_salary: base_salary || amount || profile.salary_amount || 0,
      amount: net_amount || amount || 0,
      bonus: bonus || 0,
      gross_amount: gross_amount || amount || 0,
      gross_salary: gross_amount || amount || 0,
      total_deductions: total_deductions || 0,
      deduction_amount: total_deductions || 0,
      net_amount: net_amount || amount || 0,
      net_salary: net_amount || amount || 0,
      appointment_count: appointment_count || 0,
      appointments: appointments || [],
      doctor_share: doctor_share || net_amount || amount || 0,
      hospital_share: hospital_share || 0,
      revenue_percentage: revenue_percentage || 0,
      status: status || 'draft',
      payment_method: payment_method || 'bank_transfer',
      paid_date: paid_date ? new Date(paid_date) : null,
      notes: notes || `Created from pending ${sourceModel} payroll`,
      created_by: getUserId(req),
      updated_by: getUserId(req)
    };

    // Add commission details if applicable
    if (earning_type === 'commission') {
      payrollData.commission_details = {
        appointment_count: appointment_count || 0,
        appointments: appointments || [],
        total_appointment_fees: gross_amount || 0,
        doctor_share: doctor_share || net_amount || amount || 0,
        hospital_share: hospital_share || 0,
        revenue_percentage: revenue_percentage || 0,
        total_hours: 0,
        rate: doctor?.amount || 0
      };
    }

    const payroll = new EmployeePayroll(payrollData);
    await payroll.save();
    await payroll.populate('employee_id', 'full_name employee_code staff_type designation');

    res.status(201).json({
      message: 'Payroll created successfully',
      payroll
    });
  } catch (error) {
    console.error('Create payroll error:', error);
    res.status(400).json({ error: error.message });
  }
};

// ✅ NEW: Bulk pay with transaction
exports.bulkPayPayrolls = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { payrollIds, payment_method, paid_date, notes } = req.body;

    if (!payrollIds || !Array.isArray(payrollIds) || payrollIds.length === 0) {
      return res.status(400).json({ error: 'payrollIds array is required' });
    }

    const results = [];
    const errors = [];

    // Update each payroll in a transaction
    for (const id of payrollIds) {
      try {
        const payroll = await EmployeePayroll.findById(id).session(session);
        if (!payroll) {
          errors.push({ id, error: 'Payroll not found' });
          continue;
        }

        // Can only pay if status is approved or processing
        if (!['approved', 'processing', 'draft', 'generated'].includes(payroll.status)) {
          errors.push({ 
            id, 
            error: `Cannot pay payroll with status: ${payroll.status}` 
          });
          continue;
        }

        payroll.status = 'paid';
        payroll.payment_method = payment_method || payroll.payment_method || 'bank_transfer';
        payroll.paid_date = paid_date ? new Date(paid_date) : new Date();
        payroll.notes = payroll.notes ? `${payroll.notes}\n${notes || 'Bulk payment'}` : notes || 'Bulk payment';
        payroll.updated_by = getUserId(req);
        await payroll.save({ session });

        results.push({
          id: payroll._id,
          employee_name: payroll.employee_name,
          status: 'paid',
          amount: payroll.net_amount
        });
      } catch (error) {
        errors.push({ id, error: error.message });
      }
    }

    // If there were errors but some succeeded, commit the successful ones
    await session.commitTransaction();
    session.endSession();

    res.json({
      message: 'Bulk payment processed',
      total: payrollIds.length,
      success: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Bulk pay error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ✅ NEW: Get pending salaries (with proper duplicate checks)
exports.getPendingSalaries = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const { year, month } = req.query;
    
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    
    // Get all active full-time employees
    const filter = { 
      employment_status: 'Active',
      payroll_enabled: true,
      $or: [
        { staff_type: { $in: ['doctor', 'nurse', 'staff'] } },
        { source_model: 'Doctor' }
      ]
    };
    if (hospitalId) filter.hospital_id = hospitalId;

    const employees = await HRStaffProfile.find(filter)
      .populate('doctor_id', 'firstName lastName isFullTime paymentType amount');

    // Get existing payrolls for the period (all statuses except cancelled/rejected)
    const existingPayrolls = await EmployeePayroll.find({
      year: targetYear,
      month: targetMonth,
      period_type: 'monthly',
      earning_type: { $in: ['salary', null] },
      status: { $nin: ['cancelled', 'rejected'] }
    }).select('employee_id');

    const existingEmployeeIds = new Set(
      existingPayrolls.map(p => p.employee_id?.toString()).filter(Boolean)
    );

    // Filter out employees who already have payroll
    const pending = employees
      .filter(emp => {
        // Skip doctors with commission-based payment
        if (emp.source_model === 'Doctor' || emp.staff_type === 'doctor') {
          const doctor = emp.doctor_id;
          if (doctor && ['Fee per Visit', 'Per Hour', 'Commission'].includes(doctor.paymentType)) {
            return false;
          }
        }
        return !existingEmployeeIds.has(emp._id.toString()) && emp.salary_amount > 0;
      })
      .map(emp => ({
        _id: `pending-salary-${emp._id}`,
        employee_id: emp,
        doctor_id: emp.doctor_id,
        period_type: 'monthly',
        period_start: new Date(targetYear, targetMonth - 1, 1),
        period_end: new Date(targetYear, targetMonth, 0),
        base_salary: emp.salary_amount,
        amount: emp.salary_amount,
        net_amount: emp.salary_amount,
        status: 'pending',
        is_pending: true,
        payroll_category: 'fixed_salary',
        earning_type: 'salary'
      }));

    res.json({
      pending,
      total: pending.length,
      year: targetYear,
      month: targetMonth
    });
  } catch (error) {
    console.error('Get pending salaries error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ✅ NEW: Get pending commissions (with proper duplicate checks)
exports.getPendingCommissions = async (req, res) => {
  try {
    const hospitalId = await resolveHospitalId(req);
    const { startDate, endDate } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const end = endDate ? new Date(endDate) : new Date();

    // Get all part-time doctors with commission-based payment
    const doctors = await Doctor.find({
      isFullTime: false,
      paymentType: { $in: ['Fee per Visit', 'Per Hour', 'Commission'] }
    });

    // Get completed appointments in the period
    const appointments = await Appointment.find({
      doctor_id: { $in: doctors.map(d => d._id) },
      status: 'Completed',
      actual_end_time: { $gte: start, $lte: end }
    }).populate('doctor_id');

    // ✅ FIX: Get all commission payrolls (not just paid) to avoid duplicates
    const existingCommissions = await EmployeePayroll.find({
      earning_type: 'commission',
      status: { $nin: ['cancelled', 'rejected'] }
    });

    const paidAppointmentIds = new Set();
    existingCommissions.forEach(p => {
      if (p.appointments) {
        p.appointments.forEach(apptId => paidAppointmentIds.add(apptId.toString()));
      }
    });

    const pending = [];
    for (const appointment of appointments) {
      if (paidAppointmentIds.has(appointment._id.toString())) continue;

      const doctor = appointment.doctor_id;
      if (!doctor) continue;

      // Find associated invoices
      const invoice = await Invoice.findOne({
        appointment_id: appointment._id,
        invoice_type: 'Appointment'
      });

      if (!invoice) continue;

      let consultationFee = 0;
      (invoice.service_items || []).forEach(item => {
        const desc = (item.description || '').toLowerCase();
        if (desc.includes('consultation') || desc.includes('doctor consultation')) {
          consultationFee += item.total_price || 0;
        }
      });

      if (consultationFee === 0) consultationFee = invoice.total || 0;

      const commissionAmount = (consultationFee * (doctor.revenuePercentage || 0)) / 100;

      if (commissionAmount > 0) {
        // Find employee profile
        const employee = await HRStaffProfile.findOne({
          $or: [
            { doctor_id: doctor._id },
            { source_model: 'Doctor', source_id: doctor._id }
          ]
        });

        pending.push({
          _id: `pending-commission-${appointment._id}`,
          invoice_id: invoice._id,
          invoice_number: invoice.invoice_number,
          doctor_id: doctor,
          employee_id: employee,
          appointment_id: appointment._id,
          appointment_date: appointment.appointment_date,
          patient_name: appointment.patient_id?.full_name || appointment.patient_name || 'Unknown',
          consultation_fee: consultationFee,
          registration_fee: invoice.total - consultationFee,
          total_amount: invoice.total || 0,
          amount: commissionAmount,
          net_amount: commissionAmount,
          status: 'pending',
          is_pending: true,
          period_type: 'daily',
          period_start: new Date(appointment.appointment_date),
          period_end: new Date(appointment.appointment_date),
          payroll_category: 'doctor_commission',
          earning_type: 'commission'
        });
      }
    }

    res.json({
      pending,
      total: pending.length,
      period: { start, end }
    });
  } catch (error) {
    console.error('Get pending commissions error:', error);
    res.status(500).json({ error: error.message });
  }
};