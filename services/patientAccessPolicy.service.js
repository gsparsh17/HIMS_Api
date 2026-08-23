'use strict';

const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const HRStaffProfile = require('../models/HRStaffProfile');
const Shift = require('../models/Shift');
const Hospital = require('../models/Hospital');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Prescription = require('../models/Prescription');
const EmergencyEncounter = require('../models/EmergencyEncounter');
const OTRequest = require('../models/OTRequest');
const PatientCareTeamAssignment = require('../models/PatientCareTeamAssignment');
const BreakGlassGrant = require('../models/BreakGlassGrant');
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');
const { maskAadhaar, maskAbhaNumber, maskAbhaAddress } = require('../utils/sensitiveData');
const { hasPrivilegedAction } = require('../utils/privilegedActions');

const CLINICAL_ROLES = new Set(['doctor', 'nurse', 'pathology_staff', 'radiology_staff', 'ot_staff']);
const OPERATIONS_ROLES = new Set(['staff', 'registrar', 'receptionist', 'bed_manager', 'housekeeping']);
const PAYMENT_ROLES = new Set(['accountant', 'insurance_desk', 'pharmacy']);
const ACTIVE_IPD_STATUSES = [
  'Admitted', 'Under Treatment', 'Discharge Initiated', 'Discharge Summary Pending',
  'Billing Pending', 'Payment Pending', 'Ready for Discharge'
];

function roleOf(user) { return String(user?.role || '').trim().toLowerCase(); }
function mode() {
  const configured = String(
    process.env.PATIENT_CONTEXT_AUTHZ_MODE ||
    process.env.PATIENT_CONTEXT_ENFORCEMENT ||
    ''
  ).trim().toLowerCase();
  if (['off', 'shadow', 'enforce'].includes(configured)) return configured;
  // Fail secure in production. Staging can explicitly use shadow while care-team
  // and workflow relationship telemetry is verified before go-live.
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'enforce' : 'shadow';
}
function strictAdminClinical() {
  const fallback = String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'true' : 'false';
  return String(process.env.STRICT_ADMIN_CLINICAL_ACCESS || fallback).toLowerCase() === 'true';
}

function contextPolicy(name, fallback = 'off') {
  const value = String(process.env[name] || fallback).trim().toLowerCase();
  return ['off', 'shadow', 'enforce'].includes(value) ? value : fallback;
}

function requestDeviceSignal(user) {
  const context = user?.$locals?.requestDeviceContext || user?.$requestDeviceContext || {};
  return {
    present: Boolean(context.present),
    trusted: Boolean(context.trusted),
    fingerprint: context.hashPrefix || undefined,
    label: context.label || undefined,
  };
}

function localMinutesFor(timeZone = 'Asia/Kolkata', date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    return hour * 60 + minute;
  } catch (_error) {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function parseShiftMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

async function assignedShiftSignal(user, hospitalId) {
  const profile = await staffContext(user);
  if (!profile) return { assigned: false };
  if (profile.employment_status && profile.employment_status !== 'Active') {
    return { assigned: Boolean(profile.shift), active: false, reason: 'STAFF_NOT_ACTIVE', shiftId: profile.shift ? String(profile.shift) : undefined };
  }
  if (!profile.shift) return { assigned: false };
  const [shift, hospital] = await Promise.all([
    Shift.findById(profile.shift).select('name start_time end_time is_active').lean(),
    Hospital.findById(hospitalId).select('timezone').lean(),
  ]);
  if (!shift || shift.is_active === false) {
    return { assigned: true, active: false, reason: 'SHIFT_CONFIG_INVALID', shiftId: String(profile.shift) };
  }
  const start = parseShiftMinutes(shift.start_time);
  const end = parseShiftMinutes(shift.end_time);
  if (start === null || end === null) {
    return { assigned: true, active: false, reason: 'SHIFT_TIME_INVALID', shiftId: String(profile.shift), name: shift.name };
  }
  const timezone = hospital?.timezone || 'Asia/Kolkata';
  const now = localMinutesFor(timezone);
  const active = start === end ? true : (start < end ? now >= start && now <= end : now >= start || now <= end);
  return {
    assigned: true,
    active,
    reason: active ? 'WITHIN_ASSIGNED_SHIFT' : 'OUTSIDE_ASSIGNED_SHIFT',
    shiftId: String(profile.shift),
    name: shift.name,
    timezone,
  };
}

function autoPurpose(user) {
  const role = roleOf(user);
  if (PAYMENT_ROLES.has(role)) return 'PAYMENT';
  if (OPERATIONS_ROLES.has(role)) return 'OPERATIONS';
  if (CLINICAL_ROLES.has(role)) return 'TREATMENT';
  if (role === 'admin') return strictAdminClinical() ? 'TREATMENT' : 'OPERATIONS';
  return 'OPERATIONS';
}

async function activeBreakGlass(user, patientId, hospitalId, scope = 'clinical_read') {
  if (!['clinical_read'].includes(scope)) return null;
  return BreakGlassGrant.findOne({
    hospitalId,
    patientId,
    userId: user._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    scope
  }).sort({ issuedAt: -1 }).lean();
}

async function explicitAssignment(user, patientId, hospitalId, purpose, scope) {
  return PatientCareTeamAssignment.findOne({
    hospitalId,
    patientId,
    userId: user._id,
    revokedAt: null,
    validFrom: { $lte: new Date() },
    $and: [
      { $or: [{ validTo: null }, { validTo: { $exists: false } }, { validTo: { $gt: new Date() } }] },
      { $or: [{ purposes: purpose }, { purposes: { $size: 0 } }] },
      { $or: [{ scopes: scope }, { scopes: { $size: 0 } }] }
    ]
  }).lean();
}

async function staffContext(user) {
  if (!user?._id) return null;
  const hospitalId = userHospitalId(user);
  return HRStaffProfile.findOne({
    ...(hospitalId ? { hospital_id: hospitalId } : {}),
    $or: [
      { _id: user.staff_profile_id },
      { user_id: user._id },
      { email: user.email }
    ],
    is_active: { $ne: false }
  }).select('department shift employment_status availability_status staff_type').lean();
}

async function doctorRelationship(user, patientId, hospitalId) {
  const doctor = await Doctor.findOne({
    hospitalId,
    is_active: { $ne: false },
    $or: [{ user_id: user._id }, { email: user.email }]
  }).select('_id department').lean();
  if (!doctor) return null;
  const [appointment, admission] = await Promise.all([
    Appointment.findOne({
      hospital_id: hospitalId,
      patient_id: patientId,
      doctor_id: doctor._id,
      status: { $ne: 'Cancelled' },
      is_active: { $ne: false },
      appointment_date: {
        $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_OPD_LOOKBACK_DAYS || 30) * 24 * 60 * 60 * 1000),
        $lte: new Date(Date.now() + Number(process.env.PATIENT_CONTEXT_OPD_FUTURE_DAYS || 7) * 24 * 60 * 60 * 1000)
      }
    }).sort({ appointment_date: -1 }).select('_id department_id status appointment_date').lean(),
    IPDAdmission.findOne({
      hospitalId,
      patientId,
      status: { $in: ACTIVE_IPD_STATUSES },
      is_active: { $ne: false },
      $or: [{ primaryDoctorId: doctor._id }, { secondaryDoctorIds: doctor._id }]
    }).select('_id departmentId status wardId').lean()
  ]);
  if (admission) return { type: 'IPD_DOCTOR', ref: String(admission._id), departmentId: admission.departmentId };
  if (appointment) return { type: 'OPD_DOCTOR', ref: String(appointment._id), departmentId: appointment.department_id };
  return null;
}

async function departmentRelationship(user, patientId, hospitalId) {
  const profile = await staffContext(user);
  if (profile && !['Active', undefined, null].includes(profile.employment_status)) {
    return { denied: true, reason: 'STAFF_NOT_ACTIVE' };
  }
  if (!profile?.department) return null;
  const admission = await IPDAdmission.findOne({
    hospitalId,
    patientId,
    departmentId: profile.department,
    status: { $in: ACTIVE_IPD_STATUSES },
    is_active: { $ne: false }
  }).select('_id departmentId wardId').lean();
  return admission ? { type: 'ACTIVE_DEPARTMENT_ADMISSION', ref: String(admission._id), departmentId: admission.departmentId } : null;
}

async function diagnosticRelationship(user, patientId, hospitalId) {
  const role = roleOf(user);
  if (role === 'pathology_staff') {
    const row = await LabRequest.findOne({ hospitalId, patientId, is_active: { $ne: false }, status: { $nin: ['Cancelled', 'Rejected'] }, createdAt: { $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_DIAGNOSTIC_LOOKBACK_DAYS || 30) * 86400000) } }).sort({ requestedDate: -1, createdAt: -1 }).select('_id status').lean();
    return row ? { type: 'LAB_WORKFLOW', ref: String(row._id) } : null;
  }
  if (role === 'radiology_staff') {
    const row = await RadiologyRequest.findOne({ hospitalId, patientId, is_active: { $ne: false }, status: { $nin: ['Cancelled', 'Rejected'] }, createdAt: { $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_DIAGNOSTIC_LOOKBACK_DAYS || 30) * 86400000) } }).sort({ requestedDate: -1, createdAt: -1 }).select('_id status').lean();
    return row ? { type: 'RADIOLOGY_WORKFLOW', ref: String(row._id) } : null;
  }
  return null;
}

async function emergencyRelationship(user, patientId, hospitalId) {
  const role = roleOf(user);
  if (!['doctor', 'nurse', 'ot_staff'].includes(role)) return null;
  const row = await EmergencyEncounter.findOne({
    hospitalId,
    patientId,
    status: { $in: ['registered', 'triaged', 'in_treatment', 'admitted'] }
  }).sort({ updatedAt: -1 }).select('_id status').lean();
  return row ? { type: 'ACTIVE_EMERGENCY_ENCOUNTER', ref: String(row._id) } : null;
}

async function otRelationship(user, patientId, hospitalId) {
  const role = roleOf(user);
  if (!['doctor', 'nurse', 'ot_staff'].includes(role)) return null;
  const filter = {
    hospitalId,
    patientId,
    status: { $nin: ['Cancelled', 'Completed'] },
    is_active: { $ne: false }
  };
  if (role === 'doctor') {
    const doctor = await Doctor.findOne({ hospitalId, is_active: { $ne: false }, $or: [{ user_id: user._id }, { email: user.email }] }).select('_id').lean();
    if (!doctor) return null;
    filter.$or = [
      { doctorId: doctor._id },
      { primarySurgeonId: doctor._id },
      { assistantSurgeonId: doctor._id },
      { anesthetistId: doctor._id }
    ];
  }
  const row = await OTRequest.findOne(filter).sort({ scheduledStart: -1, requestedDate: -1 }).select('_id status').lean();
  return row ? { type: 'ACTIVE_OT_CASE', ref: String(row._id) } : null;
}

async function treatmentRelationship(user, patientId, hospitalId) {
  const role = roleOf(user);
  const emergency = await emergencyRelationship(user, patientId, hospitalId);
  if (emergency) return emergency;
  const ot = await otRelationship(user, patientId, hospitalId);
  if (ot) return ot;
  if (role === 'doctor') return doctorRelationship(user, patientId, hospitalId);
  if (role === 'nurse' || role === 'ot_staff') return departmentRelationship(user, patientId, hospitalId);
  if (role === 'pathology_staff' || role === 'radiology_staff') return diagnosticRelationship(user, patientId, hospitalId);
  return null;
}

async function evaluatePatientAccess({ user, patientId, hospitalId, purpose = 'AUTO', scope = 'clinical_read' }) {
  const effectiveHospitalId = hospitalId || userHospitalId(user);
  const effectivePurpose = purpose === 'AUTO' ? autoPurpose(user) : purpose;
  const role = roleOf(user);
  const base = {
    allowed: false,
    enforce: mode() === 'enforce',
    mode: mode(),
    purpose: effectivePurpose,
    scope,
    patientId: patientId ? String(patientId) : undefined,
    hospitalId: effectiveHospitalId ? String(effectiveHospitalId) : undefined,
    role,
    dataScope: 'NONE',
    reason: 'NO_RELATIONSHIP'
  };

  if (!user || !patientId || !effectiveHospitalId) return { ...base, reason: 'MISSING_SECURITY_CONTEXT' };
  if (isPlatformAdmin(user)) return { ...base, allowed: true, dataScope: 'FULL', reason: 'PLATFORM_ADMIN' };
  if (String(userHospitalId(user) || '') !== String(effectiveHospitalId)) return { ...base, reason: 'HOSPITAL_SCOPE_MISMATCH' };
  if (hasPrivilegedAction(user, 'global_clinical_override')) {
    return { ...base, allowed: true, dataScope: 'FULL', reason: 'APPROVED_GLOBAL_CLINICAL_OVERRIDE' };
  }

  const patientExists = await Patient.exists({ _id: patientId, hospitalId: effectiveHospitalId, is_active: { $ne: false } });
  if (!patientExists) return { ...base, reason: 'PATIENT_NOT_FOUND' };

  // Emergency access is deliberately patient-specific, short-lived, audited, and
  // allowed to bypass normal shift/device context when clinically necessary.
  const breakGlass = await activeBreakGlass(user, patientId, effectiveHospitalId, scope);
  if (breakGlass) return { ...base, allowed: true, dataScope: 'FULL', reason: 'BREAK_GLASS', breakGlassGrantId: breakGlass.grantId };

  const signals = {};
  if (effectivePurpose === 'TREATMENT' && String(scope || '').startsWith('clinical')) {
    const devicePolicy = contextPolicy('PATIENT_CONTEXT_DEVICE_POLICY', 'off');
    const shiftPolicy = contextPolicy('PATIENT_CONTEXT_SHIFT_POLICY', 'off');
    if (devicePolicy !== 'off') {
      signals.device = { ...requestDeviceSignal(user), policy: devicePolicy };
      if (devicePolicy === 'enforce' && !signals.device.trusted) {
        return { ...base, signals, reason: signals.device.present ? 'UNTRUSTED_DEVICE' : 'DEVICE_CONTEXT_MISSING' };
      }
    }
    if (shiftPolicy !== 'off') {
      signals.shift = { ...(await assignedShiftSignal(user, effectiveHospitalId)), policy: shiftPolicy };
      if (shiftPolicy === 'enforce' && (!signals.shift.assigned || !signals.shift.active)) {
        return { ...base, signals, reason: signals.shift.assigned ? (signals.shift.reason || 'OUTSIDE_ASSIGNED_SHIFT') : 'SHIFT_CONTEXT_MISSING' };
      }
    }
  }

  const assignment = await explicitAssignment(user, patientId, effectiveHospitalId, effectivePurpose, scope);
  if (assignment) return { ...base, signals, allowed: true, dataScope: scope.startsWith('clinical') ? 'FULL' : 'MINIMIZED', reason: 'EXPLICIT_CARE_TEAM_ASSIGNMENT', assignmentId: String(assignment._id) };

  if (effectivePurpose === 'OPERATIONS' && (OPERATIONS_ROLES.has(role) || role === 'admin')) {
    return { ...base, allowed: true, dataScope: 'MINIMIZED', reason: 'HOSPITAL_OPERATIONS_ROLE' };
  }
  if (effectivePurpose === 'PAYMENT' && (PAYMENT_ROLES.has(role) || role === 'admin' || OPERATIONS_ROLES.has(role))) {
    return { ...base, allowed: true, dataScope: 'MINIMIZED', reason: 'PAYMENT_WORKFLOW_ROLE' };
  }
  if (role === 'admin' && !strictAdminClinical()) {
    return { ...base, allowed: true, dataScope: 'FULL', reason: 'LEGACY_ADMIN_CLINICAL_COMPAT' };
  }

  const relationship = await treatmentRelationship(user, patientId, effectiveHospitalId);
  if (relationship?.denied) return { ...base, reason: relationship.reason };
  if (relationship) {
    const diagnostic = ['LAB_WORKFLOW', 'RADIOLOGY_WORKFLOW'].includes(relationship.type);
    return { ...base, signals, allowed: true, dataScope: diagnostic ? 'MINIMIZED' : 'FULL', reason: relationship.type, relationship };
  }

  return { ...base, signals };
}

async function assertPatientAccess(args) {
  const decision = await evaluatePatientAccess(args);
  if (!decision.allowed && decision.mode === 'enforce') {
    const error = new Error('You do not currently have an authorized care/workflow relationship with this patient');
    error.statusCode = 403;
    error.code = 'PATIENT_CONTEXT_ACCESS_DENIED';
    error.decision = decision;
    throw error;
  }
  return decision;
}

async function accessiblePatientIds(user, hospitalId, purpose = 'TREATMENT') {
  // SHADOW mode observes authorization decisions without changing existing list results.
  if (mode() !== 'enforce') return null;
  const role = roleOf(user);
  if (purpose === 'TREATMENT' && CLINICAL_ROLES.has(role)) {
    const devicePolicy = contextPolicy('PATIENT_CONTEXT_DEVICE_POLICY', 'off');
    if (devicePolicy === 'enforce' && !requestDeviceSignal(user).trusted) return [];
    const shiftPolicy = contextPolicy('PATIENT_CONTEXT_SHIFT_POLICY', 'off');
    if (shiftPolicy === 'enforce') {
      const shift = await assignedShiftSignal(user, hospitalId);
      if (!shift.assigned || !shift.active) return [];
    }
  }
  if (isPlatformAdmin(user) || hasPrivilegedAction(user, 'global_clinical_override')) return null;
  if ((purpose === 'OPERATIONS' && (OPERATIONS_ROLES.has(role) || role === 'admin')) ||
      (purpose === 'PAYMENT' && (PAYMENT_ROLES.has(role) || OPERATIONS_ROLES.has(role) || role === 'admin')) ||
      (role === 'admin' && !strictAdminClinical())) return null;

  const ids = new Set();
  const assignments = await PatientCareTeamAssignment.find({
    hospitalId,
    userId: user._id,
    revokedAt: null,
    validFrom: { $lte: new Date() },
    $or: [{ validTo: null }, { validTo: { $exists: false } }, { validTo: { $gt: new Date() } }]
  }).select('patientId').lean();
  assignments.forEach((row) => ids.add(String(row.patientId)));

  if (role === 'doctor') {
    const doctor = await Doctor.findOne({ hospitalId, is_active: { $ne: false }, $or: [{ user_id: user._id }, { email: user.email }] }).select('_id').lean();
    if (doctor) {
      const [appointments, admissions] = await Promise.all([
        Appointment.find({ hospital_id: hospitalId, doctor_id: doctor._id, status: { $ne: 'Cancelled' }, is_active: { $ne: false }, appointment_date: { $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_OPD_LOOKBACK_DAYS || 30) * 24 * 60 * 60 * 1000), $lte: new Date(Date.now() + Number(process.env.PATIENT_CONTEXT_OPD_FUTURE_DAYS || 7) * 24 * 60 * 60 * 1000) } }).select('patient_id').lean(),
        IPDAdmission.find({ hospitalId, status: { $in: ACTIVE_IPD_STATUSES }, is_active: { $ne: false }, $or: [{ primaryDoctorId: doctor._id }, { secondaryDoctorIds: doctor._id }] }).select('patientId').lean()
      ]);
      appointments.forEach((row) => ids.add(String(row.patient_id)));
      admissions.forEach((row) => ids.add(String(row.patientId)));
      const otCases = await OTRequest.find({
        hospitalId,
        status: { $nin: ['Cancelled', 'Completed'] },
        $or: [
          { doctorId: doctor._id },
          { primarySurgeonId: doctor._id },
          { assistantSurgeonId: doctor._id },
          { anesthetistId: doctor._id }
        ]
      }).select('patientId').lean();
      otCases.forEach((row) => ids.add(String(row.patientId)));
    }
    const emergencyRows = await EmergencyEncounter.find({
      hospitalId,
      status: { $in: ['registered', 'triaged', 'in_treatment', 'admitted'] }
    }).select('patientId').lean();
    emergencyRows.forEach((row) => ids.add(String(row.patientId)));
  } else if (role === 'nurse' || role === 'ot_staff') {
    const profile = await staffContext(user);
    if (profile?.department && ['Active', undefined, null].includes(profile.employment_status)) {
      const admissions = await IPDAdmission.find({ hospitalId, departmentId: profile.department, status: { $in: ACTIVE_IPD_STATUSES }, is_active: { $ne: false } }).select('patientId').lean();
      admissions.forEach((row) => ids.add(String(row.patientId)));
    }
    const emergencyRows = await EmergencyEncounter.find({ hospitalId, status: { $in: ['registered', 'triaged', 'in_treatment', 'admitted'] } }).select('patientId').lean();
    emergencyRows.forEach((row) => ids.add(String(row.patientId)));
    if (role === 'ot_staff') {
      const otRows = await OTRequest.find({ hospitalId, status: { $nin: ['Cancelled', 'Completed'] } }).select('patientId').lean();
      otRows.forEach((row) => ids.add(String(row.patientId)));
    }
  } else if (role === 'pathology_staff') {
    const rows = await LabRequest.find({ hospitalId, is_active: { $ne: false }, status: { $nin: ['Cancelled', 'Rejected'] }, createdAt: { $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_DIAGNOSTIC_LOOKBACK_DAYS || 30) * 86400000) } }).select('patientId').lean();
    rows.forEach((row) => ids.add(String(row.patientId)));
  } else if (role === 'radiology_staff') {
    const rows = await RadiologyRequest.find({ hospitalId, is_active: { $ne: false }, status: { $nin: ['Cancelled', 'Rejected'] }, createdAt: { $gte: new Date(Date.now() - Number(process.env.PATIENT_CONTEXT_DIAGNOSTIC_LOOKBACK_DAYS || 30) * 86400000) } }).select('patientId').lean();
    rows.forEach((row) => ids.add(String(row.patientId)));
  }
  return Array.from(ids);
}

function maskPatientIdentifiers(patient) {
  if (!patient) return patient;
  const p = typeof patient.toObject === 'function' ? patient.toObject() : { ...patient };
  if (p.aadhaar_number) p.aadhaar_number = maskAadhaar(p.aadhaar_number);
  if (p.aadhaar_last4) p.aadhaar_last4 = String(p.aadhaar_last4).slice(-4);
  if (p.abha) {
    p.abha = { ...p.abha };
    if (p.abha.number) p.abha.number = maskAbhaNumber(p.abha.number);
    if (p.abha.address) p.abha.address = maskAbhaAddress(p.abha.address);
  }
  return p;
}

function sanitizePatientForDecision(patient, decision, { list = false } = {}) {
  if (!patient) return patient;
  let p = list ? maskPatientIdentifiers(patient) : (typeof patient.toObject === 'function' ? patient.toObject() : { ...patient });
  if (decision?.dataScope === 'MINIMIZED') {
    p = maskPatientIdentifiers(p);
    const clinicalFields = [
      'medical_history', 'allergies', 'medications', 'identityDocuments', 'clinicalNotes',
      'diagnosis', 'provisionalDiagnosis', 'finalDiagnosis', 'abha.recordLinks', 'abha.identityReconciliation'
    ];
    clinicalFields.forEach((field) => {
      if (!field.includes('.')) delete p[field];
    });
    if (p.abha) {
      delete p.abha.recordLinks;
      delete p.abha.identityReconciliation;
      delete p.abha.lastOtpTxnId;
      delete p.abha.existingSearchTxnId;
      delete p.abha.existingLoginTxnId;
    }
  }
  return p;
}

module.exports = {
  mode,
  autoPurpose,
  evaluatePatientAccess,
  assertPatientAccess,
  accessiblePatientIds,
  sanitizePatientForDecision,
  maskPatientIdentifiers,
  CLINICAL_ROLES,
  OPERATIONS_ROLES,
  PAYMENT_ROLES
};
