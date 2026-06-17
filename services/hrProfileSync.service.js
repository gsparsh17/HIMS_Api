const HRStaffProfile = require('../models/HRStaffProfile');
const User = require('../models/User');
const Hospital = require('../models/Hospital');

const SUPPORTED_SOURCE_MODELS = ['Doctor', 'Staff', 'Nurse', 'LabStaff', 'PathologyStaff', 'RadiologyStaff', 'OTStaff'];

const toLower = (v) => (v ? String(v).toLowerCase().trim() : undefined);
const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

function splitName(fullName = '') {
  const [firstName, ...last] = String(fullName).trim().split(/\s+/);
  return { firstName: firstName || '', lastName: last.join(' ') };
}

function cleanGender(gender) {
  const normalized = toLower(gender);
  if (['male', 'female', 'other', 'prefer_not_to_say'].includes(normalized)) return normalized;
  return undefined;
}

function cleanEmploymentStatus(status, isActive) {
  if (isActive === false) return 'Inactive';
  const normalized = String(status || '').toLowerCase().trim();
  if (normalized === 'inactive') return 'Inactive';
  if (normalized === 'on leave' || normalized === 'on_leave') return 'On Leave';
  if (normalized === 'suspended') return 'Suspended';
  if (normalized === 'terminated') return 'Terminated';
  return 'Active';
}

async function defaultHospitalId() {
  const hospital = await Hospital.findOne({}).select('_id');
  return hospital?._id;
}

async function getUser(userId, email) {
  if (userId) {
    const user = await User.findById(userId).select('name email role is_active hospital_id');
    if (user) return user;
  }
  if (email) return User.findOne({ email: toLower(email) }).select('name email role is_active hospital_id');
  return null;
}

function sourceToProfilePayload(sourceModel, doc, user, hospitalId) {
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const id = doc._id || plain._id;
  const userId = firstDefined(plain.user_id, plain.userId, user?._id);

  if (sourceModel === 'Doctor') {
    const fullName = `${plain.firstName || ''} ${plain.lastName || ''}`.trim() || user?.name || 'Unnamed Doctor';
    const employmentType = plain.isFullTime === false ? 'Part Time' : 'Full Time';
    return {
      source_model: 'Doctor', source_id: id, doctor_id: id, user_id: userId,
      full_name: fullName, first_name: plain.firstName, last_name: plain.lastName,
      email: toLower(firstDefined(plain.email, user?.email)), phone: plain.phone,
      gender: cleanGender(plain.gender), date_of_birth: plain.dateOfBirth, address: plain.address,
      staff_type: 'doctor', designation: 'Doctor', department: plain.department,
      specialization: plain.specialization, qualification: plain.education, license_number: plain.licenseNumber,
      joining_date: firstDefined(plain.startDate, plain.joined_at), employment_type: employmentType,
      employment_status: cleanEmploymentStatus(plain.status, true), salary_type: plain.paymentType || 'Salary',
      salary_amount: Number(plain.amount || 0), aadhar_number: plain.aadharNumber, pan_number: plain.panNumber,
      login_enabled: Boolean(userId && user?.is_active !== false), hospital_id: firstDefined(user?.hospital_id, hospitalId)
    };
  }

  if (sourceModel === 'Nurse') {
    const fullName = `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || user?.name || 'Unnamed Nurse';
    return {
      source_model: 'Nurse', source_id: id, nurse_id: id, user_id: userId,
      full_name: fullName, first_name: plain.first_name, last_name: plain.last_name,
      email: toLower(firstDefined(plain.email, user?.email)), phone: plain.phone,
      staff_type: 'nurse', designation: 'Nurse', department: plain.department_id, shift: plain.shift_id,
      joining_date: plain.joined_at, employment_status: cleanEmploymentStatus(plain.status, true),
      login_enabled: Boolean(userId && user?.is_active !== false), hospital_id: firstDefined(user?.hospital_id, hospitalId)
    };
  }

  if (sourceModel === 'Staff') {
    const role = String(plain.role || user?.role || 'staff').toLowerCase();
    const staffType = role.includes('hr') ? 'hr'
      : role.includes('store') ? 'store'
      : role.includes('pharmac') ? 'pharmacy'
      : role.includes('registrar') ? 'registrar'
      : role.includes('reception') ? 'receptionist'
      : role.includes('account') ? 'accountant'
      : role.includes('admin') ? 'admin'
      : 'staff';
    const fullName = `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || user?.name || 'Unnamed Staff';
    return {
      source_model: 'Staff', source_id: id, staff_id: id, user_id: userId,
      full_name: fullName, first_name: plain.first_name, last_name: plain.last_name,
      email: toLower(firstDefined(plain.email, user?.email)), phone: plain.phone,
      gender: cleanGender(plain.gender), staff_type: staffType, designation: plain.role || user?.role || 'Staff',
      department: plain.department, shift: plain.shift, specialization: plain.specialization,
      joining_date: plain.joined_at, employment_status: cleanEmploymentStatus(plain.status, true),
      aadhar_number: plain.aadharNumber, pan_number: plain.panNumber,
      login_enabled: Boolean(userId && user?.is_active !== false), hospital_id: firstDefined(user?.hospital_id, hospitalId)
    };
  }

  if (sourceModel === 'PathologyStaff') {
    const fullName = `${plain.first_name || ''} ${plain.last_name || ''}`.trim() || user?.name || 'Unnamed Pathology Staff';
    return {
      source_model: 'PathologyStaff', source_id: id, pathology_staff_id: id, user_id: userId,
      full_name: fullName, first_name: plain.first_name, last_name: plain.last_name,
      email: toLower(firstDefined(plain.email, user?.email)), phone: plain.phone,
      gender: cleanGender(plain.gender), date_of_birth: plain.date_of_birth,
      address: typeof plain.address === 'string' ? plain.address : [plain.address?.street, plain.address?.city, plain.address?.state, plain.address?.pincode].filter(Boolean).join(', '),
      staff_type: 'pathology_staff', designation: plain.role || 'Pathology Staff', department: plain.department,
      specialization: plain.specialization, qualification: plain.qualification,
      joining_date: plain.joined_at, employment_status: cleanEmploymentStatus(plain.status, true),
      aadhar_number: plain.aadharNumber, pan_number: plain.panNumber,
      login_enabled: Boolean(userId && user?.is_active !== false), hospital_id: firstDefined(user?.hospital_id, hospitalId)
    };
  }

  const compactSourceName = sourceModel.replace('Staff', ' Staff');
  const fullName = user?.name || `${compactSourceName} ${plain.employeeId || plain.employee_id || ''}`.trim();
  const { firstName, lastName } = splitName(fullName);
  const staffType = sourceModel === 'LabStaff' ? 'pathology_staff' : sourceModel === 'RadiologyStaff' ? 'radiology_staff' : 'ot_staff';
  const refField = sourceModel === 'LabStaff' ? 'lab_staff_id' : sourceModel === 'RadiologyStaff' ? 'radiology_staff_id' : 'ot_staff_id';
  return {
    source_model: sourceModel, source_id: id, [refField]: id, user_id: userId,
    full_name: fullName, first_name: firstName, last_name: lastName,
    email: toLower(user?.email), phone: plain.phone,
    staff_type: staffType, designation: plain.designation || compactSourceName,
    specialization: Array.isArray(plain.specializations) ? plain.specializations.join(', ') : plain.specialization,
    qualification: plain.qualification, license_number: plain.license_number,
    joining_date: plain.joined_date, employment_status: cleanEmploymentStatus(undefined, plain.is_active),
    login_enabled: Boolean(userId && user?.is_active !== false), hospital_id: firstDefined(user?.hospital_id, hospitalId)
  };
}

async function syncHRProfileFromSource(sourceModel, sourceDoc, options = {}) {
  if (!sourceDoc || !SUPPORTED_SOURCE_MODELS.includes(sourceModel)) return null;
  const email = firstDefined(sourceDoc.email, options.email);
  const user = await getUser(firstDefined(sourceDoc.user_id, sourceDoc.userId), email);
  const hospitalId = firstDefined(options.hospital_id, user?.hospital_id, await defaultHospitalId());
  const payload = sourceToProfilePayload(sourceModel, sourceDoc, user, hospitalId);
  if (!payload.email && !payload.user_id) return null;

  const query = {
    $or: [
      { source_model: sourceModel, source_id: sourceDoc._id },
      ...(payload.email ? [{ email: payload.email, hospital_id: payload.hospital_id }] : []),
      ...(payload.user_id ? [{ user_id: payload.user_id, hospital_id: payload.hospital_id }] : [])
    ]
  };

  const profile = await HRStaffProfile.findOne(query);
  if (profile) {
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') profile[key] = value;
    });
    return profile.save();
  }

  return HRStaffProfile.create(payload);
}

async function syncAllExistingHRProfiles(options = {}) {
  const results = [];
  for (const modelName of SUPPORTED_SOURCE_MODELS) {
    const Model = require(`../models/${modelName}`);
    const records = await Model.find({});
    let synced = 0;
    let skipped = 0;
    for (const record of records) {
      try {
        const profile = await syncHRProfileFromSource(modelName, record, options);
        if (profile) synced += 1;
        else skipped += 1;
      } catch (error) {
        skipped += 1;
        console.error(`HR profile sync failed for ${modelName} ${record._id}:`, error.message);
      }
    }
    results.push({ source_model: modelName, total: records.length, synced, skipped });
  }
  return results;
}

function registerHRSyncHook(schema, sourceModel) {
  schema.post('save', function(doc) {
    syncHRProfileFromSource(sourceModel, doc).catch((error) => {
      console.error(`HR profile auto-sync failed for ${sourceModel} ${doc?._id}:`, error.message);
    });
  });
}

module.exports = {
  SUPPORTED_SOURCE_MODELS,
  syncHRProfileFromSource,
  syncAllExistingHRProfiles,
  registerHRSyncHook
};
