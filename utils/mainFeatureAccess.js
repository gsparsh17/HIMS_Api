/**
 * Simple, role-oriented access model.
 *
 * This deliberately keeps permissions at hospital-workflow level. It does not
 * expose individual route/action checkboxes to administrators. A user gets
 * None, View, or Manage for each main feature.
 */
const MAIN_FEATURES = Object.freeze([
  { key: 'dashboard', label: 'Dashboard', description: 'Role dashboard and assigned work queue' },
  { key: 'registration_opd', label: 'Registration & OPD', description: 'Patients, appointments, registration and OPD work' },
  { key: 'ipd', label: 'IPD & Nursing', description: 'Admissions, patient files, vitals, nursing and discharge work' },
  { key: 'pharmacy', label: 'Pharmacy', description: 'Medicines, prescriptions, POS, purchase orders and stock' },
  { key: 'billing_finance', label: 'Billing & Finance', description: 'Billing, invoices, payments, expenses and finance views' },
  { key: 'laboratory', label: 'Laboratory & Pathology', description: 'Lab tests, sample workflow and pathology reports' },
  { key: 'radiology', label: 'Radiology', description: 'Imaging tests, imaging requests and reports' },
  { key: 'operation_theatre', label: 'Operation Theatre', description: 'OT requests, scheduling and OT records' },
  { key: 'store_inventory', label: 'Store & Inventory', description: 'Store items, requisitions, issues and inventory' },
  { key: 'hr_staff', label: 'HR & Staff', description: 'Staff, attendance, leave, payroll and HR records' },
  { key: 'reports', label: 'Reports', description: 'Operational, clinical and financial reports/exports' },
  { key: 'masters_settings', label: 'Masters & Settings', description: 'Departments, service masters, settings and user setup' }
]);

const MAIN_FEATURE_KEYS = new Set(MAIN_FEATURES.map((feature) => feature.key));
const ACCESS_ORDER = Object.freeze({ none: 0, view: 1, manage: 2, edit: 2 });

const ROLE_PRESET = Object.freeze({
  mediqliq_super_admin: { '*': 'manage' },
  admin: { '*': 'manage' },
  doctor: {
    dashboard: 'manage', registration_opd: 'view', ipd: 'manage', pharmacy: 'view', laboratory: 'view', radiology: 'view', operation_theatre: 'view', reports: 'view'
  },
  nurse: {
    dashboard: 'manage', registration_opd: 'view', ipd: 'manage', pharmacy: 'view', laboratory: 'view', radiology: 'view', reports: 'view'
  },
  staff: {
    dashboard: 'manage', registration_opd: 'manage', ipd: 'manage', billing_finance: 'manage', laboratory: 'view', radiology: 'view', operation_theatre: 'view', reports: 'view'
  },
  registrar: {
    dashboard: 'manage', registration_opd: 'manage', ipd: 'view', billing_finance: 'manage', reports: 'view'
  },
  receptionist: {
    dashboard: 'manage', registration_opd: 'manage', ipd: 'view', billing_finance: 'view', reports: 'view'
  },
  pharmacy: {
    dashboard: 'manage', pharmacy: 'manage', ipd: 'view', billing_finance: 'view', reports: 'view'
  },
  pathology_staff: {
    dashboard: 'manage', laboratory: 'manage', registration_opd: 'view', ipd: 'view', reports: 'view'
  },
  radiology_staff: {
    dashboard: 'manage', radiology: 'manage', registration_opd: 'view', ipd: 'view', reports: 'view'
  },
  ot_staff: {
    dashboard: 'manage', operation_theatre: 'manage', ipd: 'view', pharmacy: 'view', reports: 'view'
  },
  store: { dashboard: 'manage', store_inventory: 'manage', pharmacy: 'view', reports: 'view' },
  store_manager: { dashboard: 'manage', store_inventory: 'manage', pharmacy: 'view', reports: 'view' },
  inventory_manager: { dashboard: 'manage', store_inventory: 'manage', pharmacy: 'view', reports: 'view' },
  hr: { dashboard: 'manage', hr_staff: 'manage', reports: 'view' },
  hr_manager: { dashboard: 'manage', hr_staff: 'manage', reports: 'view' },
  accountant: { dashboard: 'manage', billing_finance: 'manage', reports: 'manage' },
  equipment_manager: { dashboard: 'manage', store_inventory: 'manage', reports: 'view' },
  patient: { dashboard: 'view' },
  demo: { dashboard: 'view' }
});

const EXACT_MODULE_MAP = Object.freeze({
  dashboard: 'dashboard',
  opd: 'registration_opd',
  registration: 'registration_opd',
  patients: 'registration_opd',
  appointments: 'registration_opd',
  doctors: 'registration_opd',
  ipd: 'ipd',
  pharmacy: 'pharmacy',
  medicine: 'pharmacy',
  medicines: 'pharmacy',
  nlem: 'pharmacy',
  billing: 'billing_finance',
  finance: 'billing_finance',
  invoices: 'billing_finance',
  payments: 'billing_finance',
  laboratory: 'laboratory',
  pathology: 'laboratory',
  lab: 'laboratory',
  radiology: 'radiology',
  imaging: 'radiology',
  ot: 'operation_theatre',
  operation_theatre: 'operation_theatre',
  store: 'store_inventory',
  inventory: 'store_inventory',
  hr: 'hr_staff',
  employees: 'hr_staff',
  staff: 'hr_staff',
  reports: 'reports',
  exports: 'reports',
  masters: 'masters_settings',
  settings: 'masters_settings',
  users: 'masters_settings',
  imports: 'masters_settings',
  charges: 'masters_settings',
  departments: 'masters_settings',
  rooms: 'masters_settings'
});

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
}

function normalizeAccess(value) {
  const normalized = String(value || 'none').trim().toLowerCase();
  if (normalized === 'edit') return 'manage';
  return ['none', 'view', 'manage'].includes(normalized) ? normalized : 'none';
}

function toMainFeatureKey(moduleKey) {
  const raw = String(moduleKey || '').trim().toLowerCase();
  if (!raw) return 'dashboard';
  if (MAIN_FEATURE_KEYS.has(raw)) return raw;
  if (EXACT_MODULE_MAP[raw]) return EXACT_MODULE_MAP[raw];
  // Handle legacy master-data names before splitting at the dot.
  if (raw.startsWith('masters.medicine')) return 'pharmacy';
  if (raw.startsWith('masters.lab')) return 'laboratory';
  if (raw.startsWith('masters.radiology')) return 'radiology';
  if (raw.startsWith('masters.charges') || raw.startsWith('masters.billing')) return 'masters_settings';

  const first = raw.split(/[.:/_-]/)[0];
  if (EXACT_MODULE_MAP[first]) return EXACT_MODULE_MAP[first];

  if (raw.startsWith('ipd.')) return 'ipd';
  if (raw.startsWith('pharmacy.') || raw.startsWith('masters.medicine')) return 'pharmacy';
  if (raw.startsWith('finance.') || raw.startsWith('billing.')) return 'billing_finance';
  if (raw.startsWith('lab.') || raw.startsWith('pathology.') || raw.startsWith('masters.lab')) return 'laboratory';
  if (raw.startsWith('radiology.') || raw.startsWith('masters.radiology')) return 'radiology';
  if (raw.startsWith('ot.') || raw.startsWith('procedure.')) return 'operation_theatre';
  if (raw.startsWith('store.')) return 'store_inventory';
  if (raw.startsWith('hr.') || raw.startsWith('staff.')) return 'hr_staff';
  if (raw.startsWith('report.') || raw.startsWith('export.')) return 'reports';
  return 'masters_settings';
}

function roleDefaultAccess(role, key) {
  const preset = ROLE_PRESET[normalizeRole(role)] || ROLE_PRESET.staff;
  return normalizeAccess(preset['*'] || preset[key] || 'none');
}

function blankFeaturePermissions() {
  return MAIN_FEATURES.map(({ key }) => ({ moduleKey: key, access: 'none' }));
}

function defaultFeaturePermissions(role, meta = {}) {
  return MAIN_FEATURES.map(({ key }) => ({
    moduleKey: key,
    access: roleDefaultAccess(role, key),
    ...(meta.grantedBy ? { grantedBy: meta.grantedBy } : {}),
    grantedAt: meta.grantedAt || new Date(),
    updatedAt: new Date()
  }));
}

function normalizeFeaturePermissions(input, role, meta = {}) {
  if (!Array.isArray(input)) return defaultFeaturePermissions(role, meta);

  const combined = new Map();
  for (const row of input) {
    const moduleKey = toMainFeatureKey(row?.moduleKey || row?.featureKey || row?.key);
    const access = normalizeAccess(row?.access);
    const previous = combined.get(moduleKey) || 'none';
    if (ACCESS_ORDER[access] > ACCESS_ORDER[previous]) combined.set(moduleKey, access);
  }

  return MAIN_FEATURES.map(({ key }) => ({
    moduleKey: key,
    access: combined.get(key) || 'none',
    ...(meta.grantedBy ? { grantedBy: meta.grantedBy } : {}),
    grantedAt: meta.grantedAt || new Date(),
    updatedAt: new Date()
  }));
}

function hasExplicitFeaturePermissions(user) {
  return Array.isArray(user?.modulePermissions) && user.modulePermissions.length > 0;
}

function mainFeaturePermission(user, moduleKey) {
  const mainModuleKey = toMainFeatureKey(moduleKey);
  const role = normalizeRole(user?.role);
  if (role === 'admin' || role === 'mediqliq_super_admin') {
    return { moduleKey: mainModuleKey, access: 'manage' };
  }

  if (hasExplicitFeaturePermissions(user)) {
    const access = (user.modulePermissions || [])
      .filter((row) => toMainFeatureKey(row?.moduleKey) === mainModuleKey)
      .map((row) => normalizeAccess(row?.access))
      .sort((a, b) => ACCESS_ORDER[b] - ACCESS_ORDER[a])[0] || 'none';
    return { moduleKey: mainModuleKey, access };
  }

  return { moduleKey: mainModuleKey, access: roleDefaultAccess(role, mainModuleKey) };
}

function effectiveMainFeaturePermissions(user) {
  return MAIN_FEATURES.map(({ key, label, description }) => ({
    moduleKey: key,
    label,
    description,
    access: mainFeaturePermission(user, key).access
  }));
}

function hasFeatureAccess(user, moduleKey, minimumAccess = 'view') {
  const current = mainFeaturePermission(user, moduleKey).access;
  return ACCESS_ORDER[current] >= ACCESS_ORDER[normalizeAccess(minimumAccess)];
}

function dashboardAccessFromFeatures(permissions) {
  return (permissions || []).filter((row) => normalizeAccess(row.access) !== 'none').map((row) => row.moduleKey);
}

module.exports = {
  MAIN_FEATURES,
  MAIN_FEATURE_KEYS,
  ACCESS_ORDER,
  ROLE_PRESET,
  normalizeAccess,
  toMainFeatureKey,
  roleDefaultAccess,
  defaultFeaturePermissions,
  normalizeFeaturePermissions,
  mainFeaturePermission,
  effectiveMainFeaturePermissions,
  hasFeatureAccess,
  dashboardAccessFromFeatures,
  blankFeaturePermissions
};
