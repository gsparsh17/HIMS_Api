const PathologyStaff = require('../models/PathologyStaff');
const RadiologyStaff = require('../models/RadiologyStaff');
const OTStaff = require('../models/OTStaff');

const PATHOLOGY_ROLES = new Set(['lab_technician', 'lab_scientist', 'pathologist', 'lab_assistant', 'lab_manager']);
const RADIOLOGY_DESIGNATIONS = new Set(['Radiologist', 'Radiology Technician', 'Sonographer', 'MRI Technician', 'CT Technician', 'X-Ray Technician', 'Administrator']);
const RADIOLOGY_SPECIALIZATIONS = new Set(['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Interventional Radiology', 'Nuclear Medicine', 'Fluoroscopy', 'Angiography', 'DEXA Scan', 'PET Scan']);
const OT_DESIGNATIONS = new Set(['OT Manager', 'OT Technician', 'Scrub Nurse', 'Circulating Nurse', 'Anesthesia Assistant', 'OT Staff', 'OT Nurse', 'Surgical Assistant', 'Sterilization Technician']);
const OT_SPECIALIZATIONS = new Set(['General Surgery', 'Cardiothoracic Surgery', 'Neuro Surgery', 'Orthopedic Surgery', 'Pediatric Surgery', 'Plastic Surgery', 'Urology', 'Gynecology', 'Ophthalmology', 'ENT', 'Anesthesia', 'OT Technician', 'Scrub Nurse', 'Circulating Nurse']);

const valueList = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
};

const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const userIdOf = (user) => user?._id || user || undefined;

function splitName(fullName = '') {
  const [firstName, ...lastName] = String(fullName || '').trim().split(/\s+/);
  return { firstName: firstName || '', lastName: lastName.join(' ') };
}

function pathologyRole(body) {
  const explicit = String(body.pathology_role || body.pathologyRole || '').trim().toLowerCase();
  if (PATHOLOGY_ROLES.has(explicit)) return explicit;
  const designation = String(body.designation || '').toLowerCase();
  if (designation.includes('pathologist')) return 'pathologist';
  if (designation.includes('scientist')) return 'lab_scientist';
  if (designation.includes('manager')) return 'lab_manager';
  if (designation.includes('assistant')) return 'lab_assistant';
  return 'lab_technician';
}

function radiologyDesignation(body) {
  const value = String(body.radiology_designation || body.radiologyDesignation || body.designation || '').trim();
  if (RADIOLOGY_DESIGNATIONS.has(value)) return value;
  return value.toLowerCase().includes('radiologist') ? 'Radiologist' : 'Radiology Technician';
}

function otDesignation(body) {
  const value = String(body.ot_designation || body.otDesignation || body.designation || '').trim();
  return OT_DESIGNATIONS.has(value) ? value : 'OT Staff';
}

async function deactivateNonCurrentProfiles(profile, staffType) {
  const jobs = [];
  if (staffType !== 'pathology_staff' && profile.pathology_staff_id) {
    jobs.push(PathologyStaff.updateOne({ _id: profile.pathology_staff_id, hospitalId: profile.hospital_id }, { $set: { status: 'Inactive' } }));
  }
  if (staffType !== 'radiology_staff' && profile.radiology_staff_id) {
    jobs.push(RadiologyStaff.updateOne({ _id: profile.radiology_staff_id, hospitalId: profile.hospital_id }, { $set: { is_active: false, availabilityStatus: 'Unavailable' } }));
  }
  if (staffType !== 'ot_staff' && profile.ot_staff_id) {
    jobs.push(OTStaff.updateOne({ _id: profile.ot_staff_id, hospitalId: profile.hospital_id }, { $set: { is_active: false } }));
  }
  await Promise.all(jobs);
}

/**
 * Complete the role-specific side of HR onboarding. HRStaffProfile remains the
 * employee master; this service creates/updates only the professional extension
 * required by the selected specialist role.
 */
async function syncProfessionalProfile({ body, profile, user, departmentId, hospitalId }) {
  if (!profile) return {};
  const staffType = String(body.staff_type || body.staffType || profile.staff_type || 'staff').trim().toLowerCase();
  const email = String(body.email || profile.email || '').trim().toLowerCase();
  const fullName = body.full_name || body.fullName || profile.full_name;
  const { firstName, lastName } = splitName(fullName);

  await deactivateNonCurrentProfiles(profile, staffType);

  if (staffType === 'pathology_staff') {
    const staffId = profile.employee_code || `LAB-${String(profile._id).slice(-8).toUpperCase()}`;
    const assignedTests = Array.isArray(body.assigned_lab_tests) ? body.assigned_lab_tests : undefined;
    const accessibleTestIds = Array.isArray(body.accessible_test_ids) ? body.accessible_test_ids : undefined;
    const update = {
      hospitalId,
      user_id: userIdOf(user),
      first_name: firstName,
      last_name: lastName,
      email: email || undefined,
      phone: body.phone || profile.phone || 'N/A',
      qualification: body.qualification || profile.qualification,
      specialization: body.specialization || profile.specialization,
      role: pathologyRole(body),
      department: departmentId,
      gender: ['male', 'female', 'other'].includes(String(body.gender || profile.gender || '').toLowerCase()) ? String(body.gender || profile.gender).toLowerCase() : undefined,
      date_of_birth: body.date_of_birth || profile.date_of_birth,
      address: body.address ? { street: String(body.address) } : undefined,
      status: ['Inactive', 'Suspended', 'Terminated'].includes(profile.employment_status) ? 'Inactive' : profile.employment_status === 'On Leave' ? 'On Leave' : 'Active',
      aadharNumber: body.aadhar_number || profile.aadhar_number,
      panNumber: body.pan_number || profile.pan_number,
      joined_at: body.joining_date || profile.joining_date || new Date(),
      updated_by: body.updated_by,
    };
    if (assignedTests !== undefined) update.assigned_lab_tests = assignedTests;
    if (accessibleTestIds !== undefined) update.accessible_test_ids = accessibleTestIds;

    const pathology = await PathologyStaff.findOneAndUpdate(
      { hospitalId, ...(email ? { email } : { staffId }) },
      { $set: update, $setOnInsert: { staffId, created_by: body.created_by } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    profile.pathology_staff_id = pathology._id;
    await profile.save();
    return { pathology };
  }

  if (staffType === 'radiology_staff') {
    const employeeId = String(body.radiology_employee_id || body.employeeId || profile.employee_code || `RAD-${String(profile._id).slice(-8)}`).trim().toUpperCase();
    const specializations = valueList(body.radiology_specializations || body.specializations)
      .filter((value) => RADIOLOGY_SPECIALIZATIONS.has(value));
    const radiology = await RadiologyStaff.findOneAndUpdate(
      { hospitalId, ...(email ? { email } : { employeeId }) },
      {
        $set: {
          hospitalId,
          userId: userIdOf(user),
          name: fullName,
          email: email || undefined,
          phone: body.phone || profile.phone || '',
          address: body.address || profile.address || '',
          employeeId,
          designation: radiologyDesignation(body),
          specializations,
          qualification: body.qualification || profile.qualification || '',
          experience_years: safeNumber(body.experience_years || body.experience, 0),
          license_number: body.license_number || profile.license_number || '',
          is_active: profile.employment_status !== 'Inactive' && profile.employment_status !== 'Terminated',
          modalityAssignments: valueList(body.modality_assignments || body.modalityAssignments),
          availabilityStatus: profile.availability_status === 'on_leave' ? 'On Leave' : profile.availability_status === 'busy' ? 'Busy' : profile.availability_status === 'unavailable' ? 'Unavailable' : 'Available',
          joined_date: body.joining_date || profile.joining_date || new Date(),
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    profile.radiology_staff_id = radiology._id;
    await profile.save();
    return { radiology };
  }

  if (staffType === 'ot_staff') {
    const employeeId = String(body.ot_employee_id || body.employeeId || profile.employee_code || `OT-${String(profile._id).slice(-8)}`).trim().toUpperCase();
    const specializations = valueList(body.ot_specializations || body.specializations)
      .filter((value) => OT_SPECIALIZATIONS.has(value));
    const query = profile.ot_staff_id
      ? { _id: profile.ot_staff_id, hospitalId }
      : userIdOf(user)
        ? { hospitalId, userId: userIdOf(user) }
        : { hospitalId, employeeId };
    const ot = await OTStaff.findOneAndUpdate(
      query,
      {
        $set: {
          hospitalId,
          userId: userIdOf(user),
          employeeId,
          designation: otDesignation(body),
          specializations,
          qualification: body.qualification || profile.qualification || '',
          experience_years: safeNumber(body.experience_years || body.experience, 0),
          license_number: body.license_number || profile.license_number || '',
          is_active: profile.employment_status !== 'Inactive' && profile.employment_status !== 'Terminated',
          joined_date: body.joining_date || profile.joining_date || new Date(),
          credential_valid_until: body.credential_valid_until || body.credentialValidUntil || undefined,
          maxSimultaneousCases: Math.max(1, safeNumber(body.max_simultaneous_cases || body.maxSimultaneousCases, 1)),
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    profile.ot_staff_id = ot._id;
    await profile.save();
    return { ot };
  }

  return {};
}

module.exports = {
  syncProfessionalProfile,
  PATHOLOGY_ROLES,
  RADIOLOGY_DESIGNATIONS,
  RADIOLOGY_SPECIALIZATIONS,
  OT_DESIGNATIONS,
  OT_SPECIALIZATIONS,
};
