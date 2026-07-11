const Staff = require('../models/Staff');
const Nurse = require('../models/Nurse');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');

const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function splitName(fullName = '') {
  const [firstName, ...last] = String(fullName).trim().split(/\s+/);
  return { firstName: firstName || '', lastName: last.join(' ') };
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

async function ensureDepartment(body = {}) {
  if (body.department) return body.department;

  const departmentName = body.department_name || body.departmentName;
  if (departmentName) {
    const escaped = String(departmentName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Department.findOne({ name: new RegExp(`^${escaped}$`, 'i') });
    if (existing) return existing._id;
    const created = await Department.create({ name: departmentName });
    return created._id;
  }

  let department = await Department.findOne({ name: /^General$/i });
  if (!department) department = await Department.create({ name: 'General' });
  return department._id;
}

/**
 * Synchronize an HRStaffProfile into the legacy/role-specific collections used by
 * the rest of the HIMS. This is intentionally awaited by API and bulk-import
 * flows so the linked Doctor/Staff/Nurse record exists before the request ends.
 */
async function syncRoleCollectionsFromEmployee({ profile, body = {}, user = null, departmentId = null }) {
  if (!profile) throw new Error('HR employee profile is required for role synchronization');

  const fullName = body.full_name || body.fullName || body.name || profile.full_name;
  const { firstName, lastName } = splitName(fullName);
  const staffType = String(body.staff_type || body.staffType || profile.staff_type || 'staff').toLowerCase();
  const designation = body.designation || body.role || profile.designation || staffType;
  const resolvedDepartmentId = departmentId || profile.department || await ensureDepartment({
    ...body,
    department_name: body.department_name || body.departmentName || profile.department_name
  });
  const userId = user?._id || user || profile.user_id || undefined;
  const email = String(body.email || profile.email || '').trim().toLowerCase();

  let staff = null;
  let nurse = null;
  let doctor = null;

  if (staffType !== 'doctor') {
    staff = await Staff.findOneAndUpdate(
      { email },
      {
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        email,
        phone: body.phone || profile.phone || 'N/A',
        role: designation,
        department: resolvedDepartmentId,
        specialization: body.specialization || profile.specialization,
        gender: body.gender || profile.gender,
        status: body.employment_status || profile.employment_status || 'Active',
        aadharNumber: body.aadhar_number || body.aadharNumber || profile.aadhar_number,
        panNumber: body.pan_number || body.panNumber || profile.pan_number,
        shift: body.shift || profile.shift,
        joined_at: body.joining_date || body.joiningDate || profile.joining_date || new Date()
      },
      { upsert: true, new: true, runValidators: false, setDefaultsOnInsert: true }
    );
  }

  if (staffType === 'nurse') {
    nurse = await Nurse.findOneAndUpdate(
      { email },
      {
        first_name: firstName,
        last_name: lastName,
        email,
        phone: body.phone || profile.phone || 'N/A',
        department_id: resolvedDepartmentId,
        shift_id: body.shift || profile.shift || null,
        joined_at: body.joining_date || body.joiningDate || profile.joining_date || new Date()
      },
      { upsert: true, new: true, runValidators: false, setDefaultsOnInsert: true }
    );
  }

  if (staffType === 'doctor') {
    const generatedLicense = body.license_number || body.licenseNumber || profile.license_number ||
      `LIC-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    doctor = await Doctor.findOneAndUpdate(
      { email },
      {
        user_id: userId,
        firstName,
        lastName,
        email,
        phone: body.phone || profile.phone || 'N/A',
        dateOfBirth: body.date_of_birth || body.dateOfBirth || profile.date_of_birth,
        gender: body.gender || profile.gender,
        address: body.address || profile.address,
        department: resolvedDepartmentId,
        specialization: body.specialization || profile.specialization,
        licenseNumber: generatedLicense,
        experience: body.experience || body.experience_years || 0,
        education: body.qualification || body.education || profile.qualification,
        shift: body.shift_name || body.shift,
        startDate: body.joining_date || body.joiningDate || profile.joining_date || new Date(),
        isFullTime: (body.employment_type || profile.employment_type) !== 'Part Time' &&
          (body.employment_type || profile.employment_type) !== 'Visiting',
        paymentType: body.salary_type || body.paymentType || profile.salary_type || 'Salary',
        amount: toNumber(body.salary_amount ?? body.amount ?? profile.salary_amount, 0),
        aadharNumber: body.aadhar_number || body.aadharNumber || profile.aadhar_number,
        panNumber: body.pan_number || body.panNumber || profile.pan_number,
        notes: body.notes
      },
      { upsert: true, new: true, runValidators: false, setDefaultsOnInsert: true }
    );
  }

  profile.department = resolvedDepartmentId;
  if (!profile.department_name && body.department_name) profile.department_name = body.department_name;
  if (staff) profile.staff_id = staff._id;
  if (nurse) profile.nurse_id = nurse._id;
  if (doctor) profile.doctor_id = doctor._id;
  await profile.save();

  return { staff, nurse, doctor, departmentId: resolvedDepartmentId };
}

module.exports = {
  ensureDepartment,
  roleFromStaffType,
  syncRoleCollectionsFromEmployee
};
