const Hospital = require('../models/Hospital');
const Department = require('../models/Department');
const Ward = require('../models/Ward');
const Room = require('../models/Room');
const Bed = require('../models/Bed');
const Doctor = require('../models/Doctor');
const Staff = require('../models/Staff');
const User = require('../models/User');
const BillingServiceMaster = require('../models/BillingServiceMaster');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Medicine = require('../models/Medicine');
const HospitalPharmacySetting = require('../models/HospitalPharmacySetting');
const StoreCategory = require('../models/StoreCategory');
const StoreItem = require('../models/StoreItem');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const HRStaffProfile = require('../models/HRStaffProfile');
const PathologyStaff = require('../models/PathologyStaff');
const RadiologyStaff = require('../models/RadiologyStaff');
const OTStaff = require('../models/OTStaff');
const AbdmFacility = require('../models/AbdmFacility');
const SetupAssistantState = require('../models/SetupAssistantState');
const { hasFeatureAccess, roleDefaultActions } = require('../utils/mainFeatureAccess');

const ROLE_ALIASES = Object.freeze({
  registrar: 'staff', receptionist: 'staff',
  hr_manager: 'hr',
  store: 'store_manager', inventory_manager: 'store_manager', equipment_manager: 'store_manager',
  insurance_desk: 'accountant',
});

// Each setup requirement is bound to both a main feature and a real page. This
// prevents the assistant from blocking users on modules/pages they cannot use.
const REQUIREMENTS = Object.freeze({
  admin: [
    ['hospital_profile', 'dashboard', '/dashboard/admin/profile'],
    ['departments', 'masters_settings', '/dashboard/admin/add-department'],
    ['facility_structure', 'masters_settings', '/dashboard/admin/wards'],
    ['doctors', 'registration_opd', '/dashboard/admin/add-doctor'],
    ['staff', 'hr_staff', '/dashboard/admin/add-staff'],
    ['user_access', 'hr_staff', '/dashboard/admin/staff-login'],
    ['billing_catalog', 'masters_settings', '/dashboard/admin/settings'],
    ['laboratory_catalog', 'laboratory', '/dashboard/admin/lab-tests'],
    ['radiology_catalog', 'radiology', '/dashboard/admin/imaging-tests'],
    ['ot_catalog', 'operation_theatre', '/dashboard/admin/ot/procedures'],
    ['store_catalog', 'store_inventory', '/dashboard/store/items'],
    ['finance_payers', 'billing_finance', '/dashboard/finance/payers'],
    ['abdm_integration', 'abdm', '/dashboard/abdm'],
  ],
  doctor: [
    ['doctor_profile', 'dashboard', '/dashboard/doctor/profile'],
    ['doctor_schedule', 'dashboard', '/dashboard/doctor/schedule'],
  ],
  nurse: [['workforce_profile', 'dashboard', '/dashboard/nurse/profile']],
  staff: [['workforce_profile', 'dashboard', '/dashboard/staff/profile']],
  pharmacy: [
    ['pharmacy_catalog', 'pharmacy', '/dashboard/pharmacy/medicine-list'],
    ['pharmacy_settings', 'pharmacy', '/dashboard/pharmacy/settings/general'],
  ],
  pathology_staff: [
    ['pathology_profile', 'dashboard', '/dashboard/pathology/profile'],
  ],
  radiology_staff: [
    ['radiology_profile', 'dashboard', '/dashboard/radiology/profile'],
  ],
  ot_staff: [
    ['ot_profile', 'dashboard', '/dashboard/workforce'],
  ],
  store_manager: [['store_catalog', 'store_inventory', '/dashboard/store/items']],
  hr: [
    ['hr_employees', 'hr_staff', '/dashboard/hr/employees'],
    ['user_access', 'hr_staff', '/dashboard/hr/staff-login'],
  ],
  accountant: [
    ['finance_payers', 'billing_finance', '/dashboard/finance/payers'],
  ],
  bed_manager: [],
  housekeeping: [],
  demo: [],
});

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  return ROLE_ALIASES[value] || value;
}

function normalizePath(path = '') {
  const value = String(path || '').trim().split(/[?#]/)[0] || '/';
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function hasNavigationAccess(user, path) {
  const rules = Array.isArray(user?.sidebarAccess)
    ? user.sidebarAccess.map((rule) => String(rule || '').trim()).filter(Boolean)
    : [];
  if (!rules.length) return true;
  const target = normalizePath(path);
  return rules.some((rule) => {
    if (rule.endsWith('*')) {
      const prefix = normalizePath(rule.slice(0, -1));
      return target === prefix || target.startsWith(prefix);
    }
    return target === normalizePath(rule);
  });
}

const REQUIREMENT_DEPENDENCIES = Object.freeze({
  facility_structure: [['ipd', 'view']],
  ot_catalog: [['masters_settings', 'manage']],
  finance_payers: [['masters_settings', 'manage']],
});

function hasRequirementDependencies(user, key) {
  return (REQUIREMENT_DEPENDENCIES[key] || []).every(([feature, minimum]) =>
    hasFeatureAccess(user, feature, minimum)
  );
}

function hasSetupAction(user, action, feature) {
  if (!action) return true;
  const role = String(user?.role || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
  if (role === 'mediqliq_super_admin' || (role === 'admin' && !user?.enforceModulePermissions)) return true;
  const explicit = new Set((user?.modulePermissions || []).flatMap((permission) =>
    Array.isArray(permission?.actions) ? permission.actions : []
  ));
  const defaults = new Set(roleDefaultActions(role, feature));
  return explicit.has(action) || defaults.has(action);
}

function allowedRequirements(user) {
  const role = normalizeRole(user?.role);
  const requirements = REQUIREMENTS[role] || [];
  return requirements.filter(([key, feature, path]) => (
    hasFeatureAccess(user, feature, 'manage') &&
    hasRequirementDependencies(user, key) &&
    hasNavigationAccess(user, path) &&
    (key !== 'user_access' || hasSetupAction(user, 'user_access_manage', feature))
  ));
}

const exists = async (Model, criteria) => Boolean(await Model.exists(criteria));

const CHECKERS = Object.freeze({
  hospital_profile: async ({ hospitalId }) => {
    const hospital = await Hospital.findById(hospitalId)
      .select('hospitalName address city state contact email')
      .lean();
    return Boolean(
      hospital?.hospitalName && hospital?.address && hospital?.city &&
      hospital?.state && hospital?.contact && hospital?.email
    );
  },
  departments: ({ hospitalId }) => exists(Department, { hospitalId, active: { $ne: false } }),
  facility_structure: async ({ hospitalId }) => {
    const [ward, room, bed] = await Promise.all([
      Ward.exists({ hospitalId, isActive: { $ne: false } }),
      Room.exists({ hospitalId, operationalStatus: { $ne: 'closed' } }),
      Bed.exists({ hospitalId, isActive: { $ne: false } }),
    ]);
    return Boolean(ward && room && bed);
  },
  doctors: ({ hospitalId }) => exists(Doctor, { hospitalId }),
  staff: async ({ hospitalId }) => {
    const [staff, employee] = await Promise.all([
      Staff.exists({ hospitalId, status: { $ne: 'Inactive' }, is_active: { $ne: false } }),
      HRStaffProfile.exists({ hospital_id: hospitalId, employment_status: { $ne: 'Inactive' }, is_active: { $ne: false } }),
    ]);
    return Boolean(staff || employee);
  },
  user_access: async ({ hospitalId }) => {
    const first = await User.findOne({ hospital_id: hospitalId, is_active: { $ne: false }, role: { $ne: 'patient' } }).select('_id').lean();
    if (!first) return false;
    const second = await User.findOne({ hospital_id: hospitalId, is_active: { $ne: false }, role: { $ne: 'patient' }, _id: { $ne: first._id } })
      .select('_id').lean();
    return Boolean(second);
  },
  billing_catalog: ({ hospitalId }) => exists(BillingServiceMaster, { hospitalId, active: { $ne: false } }),
  laboratory_catalog: ({ hospitalId }) => exists(LabTest, { hospitalId, is_active: { $ne: false } }),
  radiology_catalog: ({ hospitalId }) => exists(ImagingTest, { hospitalId, is_active: { $ne: false } }),
  ot_catalog: async ({ hospitalId }) => {
    const [procedure, room] = await Promise.all([
      Procedure.exists({ hospitalId, is_active: { $ne: false } }),
      Room.exists({ hospitalId, type: 'Operation Theater', operationalStatus: { $ne: 'closed' } }),
    ]);
    return Boolean(procedure && room);
  },
  pharmacy_catalog: ({ hospitalId }) => exists(Medicine, { hospitalId, is_active: { $ne: false } }),
  pharmacy_settings: ({ hospitalId }) => exists(HospitalPharmacySetting, { hospitalId }),
  store_catalog: async ({ hospitalId }) => {
    const [category, item] = await Promise.all([
      StoreCategory.exists({ hospital_id: hospitalId, is_active: { $ne: false } }),
      StoreItem.exists({ hospital_id: hospitalId, is_active: { $ne: false } }),
    ]);
    return Boolean(category && item);
  },
  finance_payers: async ({ hospitalId }) => {
    const [payer, rateCard] = await Promise.all([
      Payer.exists({ hospitalId, isActive: { $ne: false }, is_active: { $ne: false } }),
      RateCard.exists({ hospitalId }),
    ]);
    return Boolean(payer && rateCard);
  },
  doctor_profile: ({ hospitalId, userId }) => exists(Doctor, { hospitalId, user_id: userId }),
  doctor_schedule: async ({ hospitalId, userId }) => {
    const doctor = await Doctor.findOne({ hospitalId, user_id: userId })
      .select('shift workingDaysPerWeek timeSlots')
      .lean();
    return Boolean(doctor && (doctor.shift || doctor.workingDaysPerWeek?.length || doctor.timeSlots?.length));
  },
  workforce_profile: async ({ hospitalId, userId }) => {
    const [hrProfile, staffProfile] = await Promise.all([
      HRStaffProfile.exists({ hospital_id: hospitalId, user_id: userId, is_active: { $ne: false } }),
      Staff.exists({ hospitalId, user_id: userId, status: { $ne: 'Inactive' } }),
    ]);
    return Boolean(hrProfile || staffProfile);
  },
  pathology_profile: ({ hospitalId, userId }) => exists(PathologyStaff, { hospitalId, user_id: userId, status: { $ne: 'Inactive' } }),
  radiology_profile: ({ hospitalId, userId }) => exists(RadiologyStaff, { hospitalId, userId, is_active: { $ne: false } }),
  ot_profile: ({ hospitalId, userId }) => exists(OTStaff, { hospitalId, userId, is_active: { $ne: false } }),
  hr_employees: ({ hospitalId }) => exists(HRStaffProfile, { hospital_id: hospitalId, employment_status: { $ne: 'Inactive' }, is_active: { $ne: false } }),
  abdm_integration: async ({ hospitalId }) => {
    const facility = await AbdmFacility.findOne({ hospital: hospitalId })
      .select('onboardingStatus abdm.active abdm.linkageStatus')
      .lean();
    return Boolean(facility && (
      facility.onboardingStatus === 'ABDM_LIVE' ||
      facility.abdm?.active === true ||
      facility.abdm?.linkageStatus === 'LINKED'
    ));
  },
});

async function evaluateChecks({ hospitalId, userId, keys = Object.keys(CHECKERS) }) {
  const uniqueKeys = [...new Set(keys)].filter((key) => CHECKERS[key]);
  const values = await Promise.all(uniqueKeys.map(async (key) => [
    key,
    Boolean(await CHECKERS[key]({ hospitalId, userId })),
  ]));
  return Object.fromEntries(values);
}

async function getStatus({ user, hospitalId }) {
  const requirements = allowedRequirements(user);
  const requiredKeys = requirements.map(([key]) => key);
  const [checks, state] = await Promise.all([
    evaluateChecks({ hospitalId, userId: user._id, keys: requiredKeys }),
    SetupAssistantState.findOne({ hospitalId, userId: user._id }).lean(),
  ]);
  const skippedSteps = Array.isArray(state?.skippedSteps) ? state.skippedSteps : [];
  const results = {};
  requiredKeys.forEach((key) => {
    results[key] = {
      verified: Boolean(checks[key]),
      skipped: skippedSteps.includes(key),
      complete: Boolean(checks[key]) || skippedSteps.includes(key),
    };
  });
  const completeCount = Object.values(results).filter((row) => row.complete).length;
  const total = requiredKeys.length;
  const progress = total ? Math.round((completeCount / total) * 100) : 100;

  return {
    role: normalizeRole(user.role),
    requiredKeys,
    checks: results,
    skippedSteps,
    completeCount,
    total,
    progress,
    setupComplete: progress === 100,
  };
}

async function setSkipped({ user, hospitalId, stepKey, skipped }) {
  const allowed = new Set(allowedRequirements(user).map(([key]) => key));
  if (!allowed.has(stepKey)) {
    const error = new Error('This setup step is not available for the current user permissions.');
    error.statusCode = 403;
    throw error;
  }
  const update = skipped
    ? { $addToSet: { skippedSteps: stepKey }, $set: { lastViewedAt: new Date() } }
    : { $pull: { skippedSteps: stepKey }, $set: { lastViewedAt: new Date() } };
  await SetupAssistantState.findOneAndUpdate(
    { hospitalId, userId: user._id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return getStatus({ user, hospitalId });
}

async function clearSkipped({ user, hospitalId }) {
  await SetupAssistantState.updateOne(
    { hospitalId, userId: user._id },
    { $set: { skippedSteps: [], lastViewedAt: new Date() } }
  );
  return getStatus({ user, hospitalId });
}

module.exports = {
  REQUIREMENTS,
  normalizeRole,
  allowedRequirements,
  evaluateChecks,
  getStatus,
  setSkipped,
  clearSkipped,
};
