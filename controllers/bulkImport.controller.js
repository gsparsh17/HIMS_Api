const crypto = require('crypto');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');

const BulkImportJob = require('../models/BulkImportJob');
const HRStaffProfile = require('../models/HRStaffProfile');
const Medicine = require('../models/Medicine');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const BillingServiceMaster = require('../models/BillingServiceMaster');
const Procedure = require('../models/Procedure');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital');
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const Ward = require('../models/Ward');
const Calendar = require('../models/Calendar');

const { ensureDepartment, syncRoleCollectionsFromEmployee } = require('../services/hrRoleSync.service');

const ACTIVE_ADMISSION_STATUSES = [
  'Admitted',
  'Under Treatment',
  'Discharge Initiated',
  'Discharge Summary Pending',
  'Billing Pending',
  'Payment Pending',
  'Ready for Discharge'
];

const ENTITY = {
  employees: {
    title: 'Employee / HR Staff Master',
    sheet: 'Employees',
    columns: [
      ['employee_code', 'Employee Code', true],
      ['first_name', 'First Name', true],
      ['last_name', 'Last Name', false],
      ['email', 'Email', true],
      ['phone', 'Phone', false],
      ['staff_type', 'Staff Type', true],
      ['designation', 'Designation', true],
      ['department_name', 'Department', false],
      ['joining_date', 'Joining Date', false],
      ['gender', 'Gender', false],
      ['employment_type', 'Employment Type', false],
      ['employment_status', 'Employment Status', false],
      ['specialization', 'Specialization', false],
      ['qualification', 'Qualification', false],
      ['license_number', 'License Number', false],
      ['experience_years', 'Experience Years', false],
      ['salary_type', 'Salary Type', false],
      ['salary_amount', 'Salary Amount', false],
      ['address', 'Address', false],
      ['aadhar_number', 'Aadhaar Number', false],
      ['pan_number', 'PAN Number', false],
      ['login_required', 'Login Required', false],
      ['update_mode', 'Update Mode', false]
    ],
    example: {
      employee_code: 'EMP-2026-001', first_name: 'Asha', last_name: 'Verma', email: 'asha.verma@example.com',
      phone: '9876543210', staff_type: 'nurse', designation: 'Staff Nurse', department_name: 'General Medicine',
      joining_date: '2026-07-01', gender: 'female', employment_type: 'Full Time', employment_status: 'Active',
      qualification: 'BSc Nursing', salary_type: 'Salary', salary_amount: '35000', login_required: 'false'
    }
  },
  medicines: {
    title: 'Pharmacy Medicine Master',
    sheet: 'Medicines',
    columns: [
      ['name', 'Name', true], ['generic_name', 'Generic Name', false], ['brand', 'Brand', false],
      ['category', 'Category', true], ['strength', 'Strength', false], ['composition', 'Composition', false],
      ['manufacturer', 'Manufacturer', false], ['hsn_code', 'HSN Code', true], ['gst_rate', 'GST Rate', true],
      ['base_unit', 'Base Unit', false], ['pack_unit', 'Pack Unit', false], ['units_per_pack', 'Units Per Pack', false],
      ['allow_loose_sale', 'Allow Loose Sale', false], ['min_stock_level_base_units', 'Min Stock Level', false],
      ['prescription_required', 'Prescription Required', false], ['shelf', 'Shelf', false], ['rack', 'Rack', false],
      ['is_active', 'Is Active', false], ['update_mode', 'Update Mode', false]
    ],
    example: { name: 'Paracetamol', generic_name: 'Paracetamol', category: 'Analgesic', strength: '500 mg', hsn_code: '3004', gst_rate: '5', base_unit: 'tablet', pack_unit: 'strip', units_per_pack: '10', is_active: 'true' }
  },
  'lab-tests': {
    title: 'Lab Test Master',
    sheet: 'Lab Tests',
    columns: [
      ['code', 'Code', true], ['name', 'Name', true], ['category', 'Category', true], ['subCategory', 'Sub Category', false],
      ['description', 'Description', false], ['specimen_type', 'Specimen Type', false], ['specimen_volume', 'Specimen Volume', false],
      ['container_type', 'Container Type', false], ['fasting_required', 'Fasting Required', false], ['fasting_hours', 'Fasting Hours', false],
      ['preparation_instructions', 'Preparation Instructions', false], ['turnaround_time_hours', 'TAT Hours', false],
      ['normal_range', 'Normal Range', false], ['critical_low', 'Critical Low', false], ['critical_high', 'Critical High', false],
      ['units', 'Units', false], ['base_price', 'Base Price', false], ['insurance_coverage', 'Insurance Coverage', false],
      ['is_active', 'Is Active', false], ['update_mode', 'Update Mode', false]
    ],
    example: { code: 'CBC', name: 'Complete Blood Count', category: 'Hematology', specimen_type: 'Blood', turnaround_time_hours: '6', base_price: '500', is_active: 'true' }
  },
  'radiology-tests': {
    title: 'Radiology / Imaging Test Master',
    sheet: 'Imaging Tests',
    columns: [
      ['code', 'Code', true], ['name', 'Name', true], ['category', 'Category', true], ['description', 'Description', false],
      ['preparation_instructions', 'Preparation Instructions', false], ['contraindications', 'Contraindications', false],
      ['contrast_required', 'Contrast Required', false], ['contrast_details', 'Contrast Details', false],
      ['turnaround_time_hours', 'TAT Hours', false], ['base_price', 'Base Price', false],
      ['insurance_coverage', 'Insurance Coverage', false], ['is_active', 'Is Active', false], ['update_mode', 'Update Mode', false]
    ],
    example: { code: 'XR-CHEST', name: 'Chest X-Ray', category: 'X-Ray', contrast_required: 'false', turnaround_time_hours: '4', base_price: '700', is_active: 'true' }
  },
  charges: {
    title: 'Billing / Service Master',
    sheet: 'Charges',
    columns: [
      ['chargeCode', 'Charge Code', true], ['chargeName', 'Charge Name', true], ['category', 'Category', true],
      ['department', 'Department', false], ['serviceType', 'Service Type', true], ['unit', 'Unit', false],
      ['price', 'Price', true], ['taxRate', 'Tax Rate', false], ['active', 'Active', false],
      ['effectiveFrom', 'Effective From', false], ['effectiveTo', 'Effective To', false], ['notes', 'Notes', false],
      ['update_mode', 'Update Mode', false]
    ],
    example: { chargeCode: 'CONS-GEN', chargeName: 'General Consultation', category: 'Consultation', department: 'General Medicine', serviceType: 'OPD', unit: 'Each', price: '500', taxRate: '0', active: 'true', effectiveFrom: '2026-07-01' }
  },
  procedures: {
    title: 'Procedure Master',
    sheet: 'Procedures',
    columns: [
      ['code', 'Code', true], ['name', 'Name', true], ['category', 'Category', true], ['subcategory', 'Sub Category', false],
      ['description', 'Description', false], ['base_price', 'Base Price', false], ['duration_minutes', 'Duration (Minutes)', false],
      ['cpt_code', 'CPT Code', false], ['icd10_codes', 'ICD-10 Codes', false], ['equipment_required', 'Equipment Required', false],
      ['pre_procedure_instructions', 'Pre-Proc Instructions', false], ['post_procedure_instructions', 'Post-Proc Instructions', false],
      ['consent_required', 'Consent Required', false], ['facility_level', 'Facility Level', false], ['is_active', 'Is Active', false],
      ['update_mode', 'Update Mode', false]
    ],
    example: { code: 'PROC-001', name: 'Diagnostic Procedure', category: 'Diagnostic', base_price: '1500', duration_minutes: '30', consent_required: 'true', facility_level: 'Secondary,Tertiary', is_active: 'true' }
  },
  patients: {
    title: 'Patient Master',
    sheet: 'Patients',
    columns: [
      ['patient_id', 'Patient ID', false], ['uhid', 'UHID', false], ['salutation', 'Salutation', false],
      ['first_name', 'First Name', true], ['middle_name', 'Middle Name', false], ['last_name', 'Last Name', false],
      ['email', 'Email', false], ['phone', 'Phone', true], ['gender', 'Gender', true], ['dob', 'Date of Birth', true],
      ['patient_type', 'Patient Type', false], ['blood_group', 'Blood Group', false], ['address', 'Address', false],
      ['city', 'City', false], ['state', 'State', false], ['zipCode', 'ZIP Code', false], ['village', 'Village', false],
      ['district', 'District', false], ['tehsil', 'Tehsil', false], ['aadhaar_number', 'Aadhaar Number', false],
      ['emergency_contact', 'Emergency Contact', false], ['emergency_phone', 'Emergency Phone', false],
      ['medical_history', 'Medical History', false], ['allergies', 'Allergies', false], ['medications', 'Medications', false],
      ['sponsor_type', 'Sponsor Type', false], ['sponsor_name', 'Sponsor Name', false], ['sponsor_policy_number', 'Sponsor Policy Number', false],
      ['abha_number', 'ABHA Number', false], ['abha_address', 'ABHA Address', false], ['update_mode', 'Update Mode', false]
    ],
    example: { patient_id: 'PAT-10001', uhid: 'UHID-10001', salutation: 'Mr.', first_name: 'Amit', last_name: 'Sharma', phone: '9876543210', gender: 'male', dob: '1990-05-15', patient_type: 'opd', blood_group: 'O+', sponsor_type: 'self' }
  },
  appointments: {
    title: 'Appointments',
    sheet: 'Appointments',
    columns: [
      ['appointment_token', 'Appointment Token (for updates)', false],
      ['patient_uhid', 'Patient ID / UHID / Phone', true], ['doctor_email', 'Doctor Email / License / ID', true],
      ['department_name', 'Department Name', true], ['appointment_date', 'Appointment Date', true],
      ['start_time', 'Start Time (ISO or HH:mm)', false], ['duration_minutes', 'Duration Minutes', false],
      ['type', 'Appointment Mode', true], ['appointment_type', 'Appointment Type', true], ['priority', 'Priority', false],
      ['status', 'Status', false], ['notes', 'Notes', false], ['update_mode', 'Update Mode', false]
    ],
    example: { patient_uhid: 'UHID-10001', doctor_email: 'doctor@example.com', department_name: 'Cardiology', appointment_date: '2026-07-15', start_time: '10:30', duration_minutes: '20', type: 'time-based', appointment_type: 'consultation', priority: 'Normal', status: 'Scheduled', notes: 'Imported appointment' }
  },
  'ipd-admissions': {
    title: 'Active IPD Admissions',
    sheet: 'IPD Admissions',
    columns: [
      ['admission_number', 'Admission Number', false], ['ship_number', 'SHIP Number', false],
      ['patient_uhid', 'Patient ID / UHID / Phone', true], ['primary_doctor_email', 'Primary Doctor Email / License / ID', true],
      ['department_name', 'Department Name', true], ['admission_date', 'Admission Date', true],
      ['admission_type', 'Admission Type', false], ['status', 'Status', false], ['bed_code', 'Bed Code / Number', false],
      ['room_number', 'Room Number', false], ['ward_name', 'Ward Name', false], ['provisional_diagnosis', 'Provisional Diagnosis', false],
      ['chief_complaints', 'Chief Complaints', false], ['payment_type', 'Payment Type', false], ['sponsor_type', 'Sponsor Type', false],
      ['sponsor_name', 'Sponsor Name', false], ['advance_amount', 'Advance Amount', false], ['admission_notes', 'Admission Notes', false],
      ['attendant_name', 'Attendant Name', false], ['attendant_relation', 'Attendant Relation', false],
      ['attendant_mobile', 'Attendant Mobile', false], ['update_mode', 'Update Mode', false]
    ],
    example: { patient_uhid: 'UHID-10001', primary_doctor_email: 'doctor@example.com', department_name: 'General Medicine', admission_date: '2026-07-11', admission_type: 'Planned', status: 'Admitted', bed_code: 'BED0001', provisional_diagnosis: 'Observation', payment_type: 'Cash', sponsor_type: 'self', advance_amount: '5000' }
  }
};

const bool = (value) => ['true', 'yes', '1', 'y'].includes(String(value ?? '').trim().toLowerCase());
const num = (value) => value === '' || value === undefined || value === null ? undefined : Number(value);
const cell = (value) => typeof value === 'string' ? value.trim() : value;
const safeSheet = (value) => /^[=+\-@]/.test(String(value || '')) ? `'${value}` : value;
const parseArray = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dateValue(value) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function combineDateAndTime(dateInput, timeInput) {
  const date = dateValue(dateInput);
  if (!date || !timeInput) return dateValue(timeInput);
  const raw = String(timeInput).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    const [hours, minutes, seconds = '0'] = raw.split(':').map(Number);
    const combined = new Date(date);
    combined.setHours(hours, minutes, seconds, 0);
    return combined;
  }
  return dateValue(raw);
}

function modelFor(entity) {
  return ({
    employees: HRStaffProfile,
    medicines: Medicine,
    'lab-tests': LabTest,
    'radiology-tests': ImagingTest,
    charges: BillingServiceMaster,
    procedures: Procedure,
    patients: Patient,
    appointments: Appointment,
    'ipd-admissions': IPDAdmission
  })[entity];
}

function normalize(entity, row, hospitalId, userId) {
  const str = (key) => cell(row[key]);

  if (entity === 'employees') {
    return {
      employee_code: String(str('employee_code') || '').toUpperCase(),
      full_name: [str('first_name'), str('last_name')].filter(Boolean).join(' ') || str('full_name'),
      first_name: str('first_name'), last_name: str('last_name'),
      email: String(str('email') || '').toLowerCase(), phone: str('phone'),
      staff_type: String(str('staff_type') || 'staff').toLowerCase(), designation: str('designation'),
      department_name: str('department_name') || str('department'), joining_date: dateValue(str('joining_date')),
      gender: String(str('gender') || '').toLowerCase() || undefined,
      employment_type: str('employment_type') || 'Full Time', employment_status: str('employment_status') || 'Active',
      specialization: str('specialization'), qualification: str('qualification'), license_number: str('license_number'),
      experience_years: num(str('experience_years')), salary_type: str('salary_type') || 'Salary', salary_amount: num(str('salary_amount')) || 0,
      address: str('address'), aadhar_number: str('aadhar_number'), pan_number: str('pan_number'),
      login_enabled: bool(str('login_required')), hospital_id: hospitalId, created_by: userId, updated_by: userId
    };
  }

  if (entity === 'medicines') {
    return {
      hospitalId, name: str('name'), generic_name: str('generic_name'), brand: str('brand'), category: str('category'),
      strength: str('strength'), composition: str('composition'), manufacturer: str('manufacturer'),
      hsn_code: String(str('hsn_code') || ''), gst_rate: num(str('gst_rate')), base_unit: str('base_unit') || 'tablet',
      pack_unit: str('pack_unit') || 'strip', units_per_pack: num(str('units_per_pack')) || 1,
      allow_loose_sale: bool(str('allow_loose_sale')), min_stock_level_base_units: num(str('min_stock_level_base_units')) || 0,
      prescription_required: bool(str('prescription_required')), location: { shelf: str('shelf'), rack: str('rack') },
      is_active: str('is_active') === '' ? true : bool(str('is_active'))
    };
  }

  if (entity === 'lab-tests') {
    return {
      hospitalId, code: String(str('code') || '').toUpperCase(), name: str('name'), category: str('category'),
      subCategory: str('subCategory'), description: str('description'), specimen_type: str('specimen_type') || 'Blood',
      specimen_volume: str('specimen_volume'), container_type: str('container_type'), fasting_required: bool(str('fasting_required')),
      fasting_hours: num(str('fasting_hours')) || 0, preparation_instructions: str('preparation_instructions'),
      turnaround_time_hours: num(str('turnaround_time_hours')) || 24, normal_range: str('normal_range'),
      critical_low: str('critical_low'), critical_high: str('critical_high'), units: str('units'),
      base_price: num(str('base_price')) || 0, insurance_coverage: str('insurance_coverage') || 'Partial',
      is_active: str('is_active') === '' ? true : bool(str('is_active')), createdBy: userId
    };
  }

  if (entity === 'radiology-tests') {
    return {
      hospitalId, code: String(str('code') || '').toUpperCase(), name: str('name'), category: str('category'),
      description: str('description'), preparation_instructions: str('preparation_instructions'), contraindications: str('contraindications'),
      contrast_required: bool(str('contrast_required')), contrast_details: str('contrast_details'),
      turnaround_time_hours: num(str('turnaround_time_hours')) || 24, base_price: num(str('base_price')) || 0,
      insurance_coverage: str('insurance_coverage') || 'Partial', is_active: str('is_active') === '' ? true : bool(str('is_active')),
      createdBy: userId
    };
  }

  if (entity === 'procedures') {
    return {
      code: String(str('code') || '').toUpperCase(), name: str('name'), category: str('category'), subcategory: str('subcategory'),
      description: str('description'), base_price: num(str('base_price')) || 0, duration_minutes: num(str('duration_minutes')) || 30,
      cpt_code: str('cpt_code'), icd10_codes: parseArray(str('icd10_codes')), equipment_required: parseArray(str('equipment_required')),
      pre_procedure_instructions: str('pre_procedure_instructions'), post_procedure_instructions: str('post_procedure_instructions'),
      consent_required: str('consent_required') === '' ? true : bool(str('consent_required')),
      facility_level: parseArray(str('facility_level')), is_active: str('is_active') === '' ? true : bool(str('is_active')), created_by: userId
    };
  }

  if (entity === 'patients') {
    return {
      patientId: str('patient_id') || undefined, uhid: str('uhid') || undefined, salutation: str('salutation') || undefined,
      first_name: str('first_name'), middle_name: str('middle_name'), last_name: str('last_name'), email: str('email'),
      phone: str('phone'), gender: String(str('gender') || '').toLowerCase(), dob: dateValue(str('dob')),
      patient_type: String(str('patient_type') || 'opd').toLowerCase(), blood_group: str('blood_group') || '', address: str('address'),
      city: str('city'), state: str('state'), zipCode: str('zipCode'), village: str('village'), district: str('district'), tehsil: str('tehsil'),
      aadhaar_number: str('aadhaar_number'), emergency_contact: str('emergency_contact'), emergency_phone: str('emergency_phone'),
      medical_history: str('medical_history'), allergies: str('allergies'), medications: str('medications'),
      sponsor_type: str('sponsor_type') || 'self', sponsor_name: str('sponsor_name'), sponsor_policy_number: str('sponsor_policy_number'),
      abha: (str('abha_number') || str('abha_address')) ? {
        number: str('abha_number') || undefined, address: str('abha_address') || undefined,
        status: 'manually_captured', registrationMode: 'manual_capture'
      } : undefined
    };
  }

  if (entity === 'appointments') {
    const appointmentDate = dateValue(str('appointment_date'));
    const type = String(str('type') || 'time-based').toLowerCase();
    const duration = num(str('duration_minutes')) || 10;
    const startTime = type === 'time-based' ? combineDateAndTime(appointmentDate, str('start_time')) : undefined;
    return {
      token: str('appointment_token') || undefined,
      hospital_id: hospitalId,
      appointment_date: appointmentDate,
      start_time: startTime,
      end_time: startTime ? new Date(startTime.getTime() + duration * 60000) : undefined,
      type,
      appointment_type: String(str('appointment_type') || 'consultation').toLowerCase(),
      priority: str('priority') || 'Normal', status: str('status') || 'Scheduled', notes: str('notes'),
      _import: {
        patient_ref: str('patient_uhid'), doctor_ref: str('doctor_email'), department_name: str('department_name'), duration_minutes: duration
      }
    };
  }

  if (entity === 'ipd-admissions') {
    return {
      admissionNumber: str('admission_number') || undefined, shipNumber: str('ship_number') || undefined,
      hospitalId, admissionDate: dateValue(str('admission_date')), admissionType: str('admission_type') || 'Planned',
      status: str('status') || 'Admitted', provisionalDiagnosis: str('provisional_diagnosis'), chiefComplaints: str('chief_complaints'),
      paymentType: str('payment_type') || 'Cash', sponsorType: str('sponsor_type') || 'self', sponsorName: str('sponsor_name'),
      advanceAmount: num(str('advance_amount')) || 0, admissionNotes: str('admission_notes'),
      attendant: {
        name: str('attendant_name'), relation: str('attendant_relation'), mobile: str('attendant_mobile')
      },
      pharmacyClearanceStatus: 'pending', createdBy: userId, updatedBy: userId,
      _import: {
        patient_ref: str('patient_uhid'), doctor_ref: str('primary_doctor_email'), department_name: str('department_name'),
        bed_ref: str('bed_code'), room_number: str('room_number'), ward_name: str('ward_name')
      }
    };
  }

  return {
    hospitalId, chargeCode: String(str('chargeCode') || '').toUpperCase(), chargeName: str('chargeName'), category: str('category'),
    departmentName: str('department'), serviceType: str('serviceType'), unit: str('unit') || 'Each', price: num(str('price')),
    taxRate: num(str('taxRate')) || 0, active: str('active') === '' ? true : bool(str('active')),
    effectiveFrom: dateValue(str('effectiveFrom')) || new Date(), effectiveTo: dateValue(str('effectiveTo')), notes: str('notes'),
    createdBy: userId, updatedBy: userId
  };
}

function validate(entity, data) {
  const errors = [];
  const required = {
    employees: ['employee_code', 'full_name', 'email', 'staff_type', 'designation'],
    medicines: ['name', 'category', 'hsn_code', 'gst_rate'],
    'lab-tests': ['code', 'name', 'category'],
    'radiology-tests': ['code', 'name', 'category'],
    charges: ['chargeCode', 'chargeName', 'category', 'serviceType', 'price'],
    procedures: ['code', 'name', 'category'],
    patients: ['first_name', 'phone', 'gender', 'dob'],
    appointments: ['appointment_date', 'type', 'appointment_type'],
    'ipd-admissions': ['admissionDate', 'admissionType', 'status']
  }[entity] || [];

  required.forEach((key) => {
    if (data[key] === undefined || data[key] === null || data[key] === '') errors.push(`${key} is required`);
  });

  if (entity === 'employees' && data.email && !/^\S+@\S+\.\S+$/.test(data.email)) errors.push('email is invalid');
  if (entity === 'medicines') {
    if (data.hsn_code && !/^\d{4,8}$/.test(String(data.hsn_code))) errors.push('hsn_code must be 4-8 digits');
    if (data.gst_rate !== undefined && ![0, 5, 12, 18, 28].includes(Number(data.gst_rate))) errors.push('gst_rate must be 0, 5, 12, 18 or 28');
  }

  ['price', 'base_price', 'turnaround_time_hours', 'taxRate', 'duration_minutes', 'salary_amount', 'advanceAmount'].forEach((key) => {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '' && (!Number.isFinite(Number(data[key])) || Number(data[key]) < 0)) {
      errors.push(`${key} must be a non-negative number`);
    }
  });

  if (entity === 'patients') {
    if (!['male', 'female', 'other'].includes(data.gender)) errors.push('gender must be male, female or other');
    if (!data.dob || Number.isNaN(new Date(data.dob).getTime())) errors.push('dob must be a valid date');
    if (!['opd', 'ipd', 'walkin'].includes(data.patient_type)) errors.push('patient_type must be opd, ipd or walkin');
    if (data.aadhaar_number && !/^\d{12}$/.test(String(data.aadhaar_number))) errors.push('aadhaar_number must be exactly 12 digits');
  }

  if (entity === 'appointments') {
    if (!['time-based', 'number-based'].includes(data.type)) errors.push('type must be time-based or number-based');
    if (!['consultation', 'follow-up', 'checkup', 'procedure', 'surgery', 'emergency'].includes(data.appointment_type)) errors.push('invalid appointment_type');
    if (!['Low', 'Normal', 'High', 'Urgent'].includes(data.priority)) errors.push('priority must be Low, Normal, High or Urgent');
    if (!['Scheduled', 'In Progress', 'Completed', 'Cancelled'].includes(data.status)) errors.push('invalid appointment status');
    if (data.type === 'time-based' && !data.start_time) errors.push('start_time is required for time-based appointments');
  }

  if (entity === 'ipd-admissions') {
    if (!['Emergency', 'Planned', 'Referral', 'Transfer'].includes(data.admissionType)) errors.push('invalid admission_type');
    const allowed = [...ACTIVE_ADMISSION_STATUSES, 'Discharged', 'Cancelled', 'LAMA', 'DAMA', 'Expired'];
    if (!allowed.includes(data.status)) errors.push('invalid admission status');
  }

  if (entity === 'procedures') {
    if (data.duration_minutes !== undefined && Number(data.duration_minutes) < 1) errors.push('duration_minutes must be at least 1');
    const validLevels = ['Primary', 'Secondary', 'Tertiary'];
    const invalidLevels = (data.facility_level || []).filter((level) => !validLevels.includes(level));
    if (invalidLevels.length) errors.push(`facility_level must be one of: ${validLevels.join(', ')}. Invalid values: ${invalidLevels.join(', ')}`);
  }

  const categorySets = {
    'lab-tests': ['Hematology', 'Biochemistry', 'Microbiology', 'Immunology', 'Pathology', 'Serology', 'Toxicology', 'Endocrinology', 'Cardiology', 'Molecular Diagnostics', 'Genetic Testing', 'Other'],
    'radiology-tests': ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'ECG', 'Echocardiography', 'Mammography', 'PET Scan', 'DEXA Scan', 'Fluoroscopy', 'Angiography', 'Other'],
    procedures: ['Diagnostic', 'Preventive', 'Restorative', 'Endodontics', 'Periodontics', 'Prosthodontics', 'Implant', 'Oral Surgery', 'Orthodontics', 'Adjunctive', 'Radiology', 'Laboratory', 'Anesthesia', 'Emergency', 'Consultation', 'Follow-up', 'Other']
  };
  if (categorySets[entity] && data.category && !categorySets[entity].includes(data.category)) errors.push(`category must be one of: ${categorySets[entity].join(', ')}`);

  return errors;
}

async function findPatientByReference(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return null;
  if (/^[0-9a-fA-F]{24}$/.test(ref)) {
    const byId = await Patient.findById(ref);
    if (byId) return byId;
  }
  return Patient.findOne({ $or: [{ patientId: ref }, { uhid: ref }, { phone: ref }] });
}

async function findDoctorByReference(reference) {
  const ref = String(reference || '').trim();
  if (!ref) return null;
  if (/^[0-9a-fA-F]{24}$/.test(ref)) {
    const byId = await Doctor.findById(ref);
    if (byId) return byId;
  }
  return Doctor.findOne({
    $or: [
      { email: ref.toLowerCase() },
      { licenseNumber: ref },
      { doctorId: ref }
    ]
  });
}

async function findDepartmentByName(name) {
  if (!name) return null;
  return Department.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
}

async function findBedByReference(reference, roomNumber, wardName) {
  const ref = String(reference || '').trim();
  let query = null;
  if (ref) query = { $or: [{ bedCode: ref.toUpperCase() }, { bedNumber: ref }] };

  let beds = query ? await Bed.find(query).populate('roomId wardId') : [];
  if (!beds.length && (roomNumber || wardName)) beds = await Bed.find({}).populate('roomId wardId');

  if (roomNumber) beds = beds.filter((bed) => String(bed.roomId?.room_number || '') === String(roomNumber));
  if (wardName) beds = beds.filter((bed) => String(bed.wardId?.name || '').toLowerCase() === String(wardName).toLowerCase());
  return beds[0] || null;
}

async function prepareData(entity, row, hospitalId, userId) {
  const data = normalize(entity, row, hospitalId, userId);
  const errors = validate(entity, data);
  const warnings = [];

  if (entity === 'employees') {
    try {
      data.department = await ensureDepartment({ department_name: data.department_name });
    } catch (error) {
      errors.push(`department resolution failed: ${error.message}`);
    }
    if (data.login_enabled) warnings.push('Login Required is informational in bulk import; no password is stored or auto-generated. Create credentials separately.');
  }

  if (entity === 'appointments') {
    const patient = await findPatientByReference(data._import?.patient_ref);
    const doctor = await findDoctorByReference(data._import?.doctor_ref);
    const department = await findDepartmentByName(data._import?.department_name);

    if (!patient) errors.push(`patient not found for reference: ${data._import?.patient_ref || '(blank)'}`);
    if (!doctor) errors.push(`doctor not found for reference: ${data._import?.doctor_ref || '(blank)'}`);
    if (!department) errors.push(`department not found: ${data._import?.department_name || '(blank)'}`);
    if (!hospitalId) errors.push('hospital scope is required for appointment import');

    if (patient) data.patient_id = patient._id;
    if (doctor) data.doctor_id = doctor._id;
    if (department) data.department_id = department._id;

    if (!errors.length) {
      const calendar = await Calendar.findOne({ hospitalId });
      const dateKey = new Date(data.appointment_date).toISOString().slice(0, 10);
      const day = calendar?.days?.find((entry) => new Date(entry.date).toISOString().slice(0, 10) === dateKey);
      const doctorDay = day?.doctors?.find((entry) => String(entry.doctorId) === String(data.doctor_id));
      if (!calendar || !day || !doctorDay) {
        warnings.push('Calendar schedule mirror not found for this doctor/date. The appointment will still be imported, but it may not appear in calendar slot occupancy until the calendar is rebuilt.');
      } else if (data.type === 'time-based') {
        const start = new Date(data.start_time);
        const end = new Date(data.end_time);
        const conflict = (doctorDay.bookedAppointments || []).some((entry) => start < new Date(entry.endTime) && end > new Date(entry.startTime));
        if (conflict) errors.push('appointment time conflicts with an existing calendar booking');
      }
    }
  }

  if (entity === 'ipd-admissions') {
    const patient = await findPatientByReference(data._import?.patient_ref);
    const doctor = await findDoctorByReference(data._import?.doctor_ref);
    const department = await findDepartmentByName(data._import?.department_name);
    const bed = await findBedByReference(data._import?.bed_ref, data._import?.room_number, data._import?.ward_name);

    if (!patient) errors.push(`patient not found for reference: ${data._import?.patient_ref || '(blank)'}`);
    if (!doctor) errors.push(`primary doctor not found for reference: ${data._import?.doctor_ref || '(blank)'}`);
    if (!department) errors.push(`department not found: ${data._import?.department_name || '(blank)'}`);
    if (!hospitalId) errors.push('hospital scope is required for IPD admission import');
    if ((data._import?.bed_ref || data._import?.room_number || data._import?.ward_name) && !bed) errors.push('bed could not be resolved from bed/room/ward reference');

    if (patient) data.patientId = patient._id;
    if (doctor) data.primaryDoctorId = doctor._id;
    if (department) data.departmentId = department._id;
    if (bed) {
      data.bedId = bed._id;
      data.roomId = bed.roomId?._id || bed.roomId;
      data.wardId = bed.wardId?._id || bed.wardId;
    }
  }

  return { data, errors, warnings };
}

function natural(entity, data) {
  if (entity === 'employees') return data.employee_code || data.email;
  if (entity === 'medicines') return [data.name, data.strength || '', data.brand || '', data.generic_name || '', data.composition || ''].map((value) => String(value).toLowerCase()).join('|');
  if (entity === 'charges') return `${data.chargeCode}|${data.effectiveFrom ? new Date(data.effectiveFrom).toISOString().slice(0, 10) : 'unknown'}`;
  if (['procedures', 'lab-tests', 'radiology-tests'].includes(entity)) return data.code;
  if (entity === 'patients') return data.patientId || data.uhid || data.phone;
  if (entity === 'appointments') return data.token || [data._import?.patient_ref, data._import?.doctor_ref, data.appointment_date ? new Date(data.appointment_date).toISOString().slice(0, 10) : '', data.start_time ? new Date(data.start_time).toISOString() : data.type].join('|');
  if (entity === 'ipd-admissions') return data.admissionNumber || data.shipNumber || `${data._import?.patient_ref || data.patientId}|active-admission`;
  return '';
}

async function existing(entity, data, hospitalId) {
  if (entity === 'employees') {
    return HRStaffProfile.findOne({ hospital_id: hospitalId, $or: [{ employee_code: data.employee_code }, { email: data.email }] });
  }
  if (entity === 'medicines') {
    return Medicine.findOne({ hospitalId, name: data.name, strength: data.strength || '', brand: data.brand || '', generic_name: data.generic_name || '', composition: data.composition || '' });
  }
  if (entity === 'charges') return BillingServiceMaster.findOne({ hospitalId, chargeCode: data.chargeCode, effectiveFrom: data.effectiveFrom });
  if (entity === 'procedures') return Procedure.findOne({ code: data.code });
  if (['lab-tests', 'radiology-tests'].includes(entity)) return modelFor(entity).findOne({ hospitalId, code: data.code });
  if (entity === 'patients') {
    const clauses = [];
    if (data.patientId) clauses.push({ patientId: data.patientId });
    if (data.uhid) clauses.push({ uhid: data.uhid });
    if (data.phone) clauses.push({ phone: data.phone });
    return clauses.length ? Patient.findOne({ $or: clauses }) : null;
  }
  if (entity === 'appointments') {
    if (data.token) {
      const byToken = await Appointment.findOne({ hospital_id: hospitalId, token: data.token });
      if (byToken) return byToken;
    }
    const query = { hospital_id: hospitalId, patient_id: data.patient_id, doctor_id: data.doctor_id, appointment_date: data.appointment_date };
    if (data.type === 'time-based' && data.start_time) query.start_time = data.start_time;
    else query.type = data.type;
    return Appointment.findOne(query);
  }
  if (entity === 'ipd-admissions') {
    if (data.admissionNumber) {
      const byNumber = await IPDAdmission.findOne({ admissionNumber: data.admissionNumber, hospitalId });
      if (byNumber) return byNumber;
    }
    if (data.shipNumber) {
      const byShip = await IPDAdmission.findOne({ shipNumber: data.shipNumber, hospitalId });
      if (byShip) return byShip;
    }
    return IPDAdmission.findOne({ patientId: data.patientId, hospitalId, status: { $in: ACTIVE_ADMISSION_STATUSES } });
  }
  return null;
}

function persistenceData(entity, data) {
  const output = { ...data };
  delete output._import;
  if (entity === 'employees') delete output.experience_years;
  return output;
}

async function validateOperationalConstraints(entity, data, target) {
  const errors = [];
  if (entity === 'ipd-admissions' && data.bedId && ACTIVE_ADMISSION_STATUSES.includes(data.status)) {
    const bed = await Bed.findById(data.bedId);
    if (!bed) errors.push('selected bed no longer exists');
    else if (bed.status !== 'Available' && String(bed.currentAdmissionId || '') !== String(target?._id || '')) {
      errors.push(`bed ${bed.bedCode || bed.bedNumber} is not available`);
    }
  }
  return errors;
}

async function rowsFromFile(file) {
  const workbook = new ExcelJS.Workbook();
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'csv') await workbook.csv.read(Readable.from(file.buffer));
    else await workbook.xlsx.load(file.buffer);
  } catch (error) {
    throw new Error(`Failed to parse file: ${error.message}`);
  }

  const worksheet = workbook.worksheets.find((sheet) => sheet.name !== 'Instructions') || workbook.worksheets[0];
  if (!worksheet) throw new Error('Workbook must contain a data sheet');

  const headers = [];
  worksheet.getRow(1).eachCell((entry, columnNumber) => {
    const header = String(entry.value || '').trim();
    if (header) headers[columnNumber - 1] = header;
  });
  const validHeaders = headers.filter(Boolean);
  if (!validHeaders.length) throw new Error('No headers found in the first row');

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const output = {};
    let hasData = false;
    validHeaders.forEach((header, index) => {
      const raw = row.getCell(index + 1).value;
      const value = raw?.text !== undefined ? raw.text : raw?.result !== undefined ? raw.result : raw;
      output[header] = value !== undefined && value !== null ? String(value).trim() : '';
      if (output[header] !== '') hasData = true;
    });
    if (hasData) rows.push({ rowNumber, row: output });
  });
  return { headers: validHeaders, rows };
}

async function syncAppointmentCalendar(appointment, durationMinutes = 10) {
  const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
  if (!calendar) return false;
  const dateKey = new Date(appointment.appointment_date).toISOString().slice(0, 10);
  const day = calendar.days.find((entry) => new Date(entry.date).toISOString().slice(0, 10) === dateKey);
  if (!day) return false;
  const doctorDay = day.doctors.find((entry) => String(entry.doctorId) === String(appointment.doctor_id));
  if (!doctorDay) return false;

  if (appointment.type === 'time-based') {
    const exists = (doctorDay.bookedAppointments || []).some((entry) => String(entry.appointmentId) === String(appointment._id));
    if (!exists) {
      doctorDay.bookedAppointments.push({
        startTime: appointment.start_time,
        endTime: appointment.end_time,
        duration: durationMinutes,
        appointmentId: appointment._id,
        status: appointment.status
      });
    }
  } else {
    let serialNumber = appointment.serial_number;
    if (!serialNumber) {
      const last = [...(doctorDay.bookedPatients || [])].sort((a, b) => Number(b.serialNumber || 0) - Number(a.serialNumber || 0))[0];
      serialNumber = last ? Number(last.serialNumber) + 1 : 1;
      appointment.serial_number = serialNumber;
      await appointment.save();
    }
    const exists = (doctorDay.bookedPatients || []).some((entry) => String(entry.appointmentId) === String(appointment._id));
    if (!exists) doctorDay.bookedPatients.push({ patientId: appointment.patient_id, serialNumber, appointmentId: appointment._id });
  }
  await calendar.save();
  return true;
}

async function removeAppointmentFromCalendar(appointment) {
  if (!appointment?.hospital_id || !appointment?.appointment_date) return;
  const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
  if (!calendar) return;
  const dateKey = new Date(appointment.appointment_date).toISOString().slice(0, 10);
  const day = calendar.days.find((entry) => new Date(entry.date).toISOString().slice(0, 10) === dateKey);
  const doctorDay = day?.doctors?.find((entry) => String(entry.doctorId) === String(appointment.doctor_id));
  if (!doctorDay) return;
  doctorDay.bookedAppointments = (doctorDay.bookedAppointments || []).filter((entry) => String(entry.appointmentId) !== String(appointment._id));
  doctorDay.bookedPatients = (doctorDay.bookedPatients || []).filter((entry) => String(entry.appointmentId) !== String(appointment._id));
  await calendar.save();
}

async function admissionDisplayData(admission) {
  const [doctor, department, bed, ward] = await Promise.all([
    admission.primaryDoctorId ? Doctor.findById(admission.primaryDoctorId).select('firstName lastName') : null,
    admission.departmentId ? Department.findById(admission.departmentId).select('name') : null,
    admission.bedId ? Bed.findById(admission.bedId).select('bedNumber bedCode') : null,
    admission.wardId ? Ward.findById(admission.wardId).select('name') : null
  ]);
  return {
    admission_id: admission._id,
    ship_number: admission.shipNumber,
    registration_number: admission.admissionNumber,
    ward_name: ward?.name || '',
    bed_number: bed?.bedNumber || bed?.bedCode || '',
    doctor_name: doctor ? `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() : '',
    department_name: department?.name || '',
    status: 'active'
  };
}

async function applyAdmissionSideEffects(admission, previous = null) {
  if (previous?.bedId && String(previous.bedId) !== String(admission.bedId || '')) {
    await Bed.updateOne({ _id: previous.bedId, currentAdmissionId: admission._id }, { $set: { status: 'Available' }, $unset: { currentAdmissionId: 1 } });
  }

  if (previous?.patientId && String(previous.patientId) !== String(admission.patientId || '')) {
    await Patient.updateOne({ _id: previous.patientId }, { $pull: { active_admissions: { admission_id: admission._id } } });
    const previousHasActive = await IPDAdmission.exists({ _id: { $ne: admission._id }, patientId: previous.patientId, status: { $in: ACTIVE_ADMISSION_STATUSES } });
    if (!previousHasActive) await Patient.updateOne({ _id: previous.patientId }, { $set: { patient_type: 'opd' } });
  }

  const active = ACTIVE_ADMISSION_STATUSES.includes(admission.status);
  if (active && admission.bedId) {
    await Bed.findByIdAndUpdate(admission.bedId, { status: 'Occupied', currentAdmissionId: admission._id });
  } else if (!active && admission.bedId) {
    await Bed.updateOne({ _id: admission.bedId, currentAdmissionId: admission._id }, { $set: { status: 'Available' }, $unset: { currentAdmissionId: 1 } });
  }

  await Patient.updateOne({ _id: admission.patientId }, { $pull: { active_admissions: { admission_id: admission._id } } });
  if (active) {
    const display = await admissionDisplayData(admission);
    await Patient.updateOne(
      { _id: admission.patientId },
      { $set: { patient_type: 'ipd', last_pharmacy_visit: new Date() }, $addToSet: { active_admissions: display } }
    );
  } else {
    const otherActive = await IPDAdmission.exists({ _id: { $ne: admission._id }, patientId: admission.patientId, status: { $in: ACTIVE_ADMISSION_STATUSES } });
    if (!otherActive) await Patient.updateOne({ _id: admission.patientId }, { $set: { patient_type: 'opd' } });
  }
}

async function createEntityRecord(entity, data, userId) {
  const clean = persistenceData(entity, data);

  if (entity === 'appointments') {
    const appointment = await Appointment.create(clean);
    await syncAppointmentCalendar(appointment, data._import?.duration_minutes || 10);
    return appointment;
  }

  if (entity === 'ipd-admissions') {
    const admission = await IPDAdmission.create({ ...clean, createdBy: userId, updatedBy: userId });
    await applyAdmissionSideEffects(admission);
    return admission;
  }

  const Model = modelFor(entity);
  const doc = await Model.create(clean);
  if (entity === 'employees') {
    await syncRoleCollectionsFromEmployee({ profile: doc, body: data, departmentId: doc.department });
  }
  return doc;
}

async function updateEntityRecord(entity, current, data, userId) {
  const before = current.toObject ? current.toObject() : { ...current };
  const clean = persistenceData(entity, data);

  if (entity === 'appointments') {
    await removeAppointmentFromCalendar(current);
    current.set(clean);
    await current.save();
    await syncAppointmentCalendar(current, data._import?.duration_minutes || 10);
    return { doc: current, before };
  }

  if (entity === 'ipd-admissions') {
    current.set({ ...clean, updatedBy: userId });
    await current.save();
    await applyAdmissionSideEffects(current, before);
    return { doc: current, before };
  }

  const updateData = { ...clean };
  if (entity === 'employees') updateData.updated_by = userId;
  if (entity === 'charges' || entity === 'procedures') updateData.updatedBy = userId;
  current.set(updateData);
  await current.save();
  if (entity === 'employees') {
    await syncRoleCollectionsFromEmployee({ profile: current, body: data, departmentId: current.department });
  }
  return { doc: current, before };
}

exports.template = async (req, res) => {
  try {
    const meta = ENTITY[req.params.entity];
    if (!meta) return res.status(404).json({ success: false, message: 'Unknown import entity' });

    const workbook = new ExcelJS.Workbook();
    const instructions = workbook.addWorksheet('Instructions');
    instructions.addRow([meta.title]);
    instructions.addRow(['Required columns are marked Required. Enter data in the data sheet only. No formulas or macros are imported.']);
    instructions.addRow(['CREATE_ONLY skips existing natural keys. UPDATE_BY_KEY updates only after explicit preview and commit.']);
    if (req.params.entity === 'employees') instructions.addRow(['Employee imports immediately synchronize Doctor / Staff / Nurse role collections. Login passwords are never imported.']);
    if (req.params.entity === 'appointments') instructions.addRow(['Patient and doctor references may be UHID/Patient ID/phone and doctor email/license/doctor ID.']);
    if (req.params.entity === 'ipd-admissions') instructions.addRow(['Active admission import updates bed occupancy and the patient active_admissions mirror. It does not generate registration/admission fee invoices.']);
    instructions.addRow([]);
    instructions.addRow(['Column Definitions:']);
    meta.columns.forEach((column) => instructions.addRow([`${column[0]}${column[2] ? ' (Required)' : ''}: ${column[1]}`]));

    const worksheet = workbook.addWorksheet(meta.sheet);
    worksheet.addRow(meta.columns.map((column) => column[0]));
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    worksheet.addRow(meta.columns.map((column) => meta.example?.[column[0]] ?? ''));
    worksheet.columns.forEach((column) => { column.width = 22; });
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-import-template.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Template generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.preview = async (req, res) => {
  try {
    const entity = req.params.entity;
    const meta = ENTITY[entity];
    if (!meta) return res.status(404).json({ success: false, message: 'Unknown import entity' });
    if (!req.file) return res.status(400).json({ success: false, message: 'An .xlsx or .csv file is required' });

    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'csv'].includes(ext)) return res.status(400).json({ success: false, message: 'Only .xlsx or .csv files are supported' });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ success: false, message: 'File size cannot exceed 10MB' });

    const hospitalId = req.user.hospital_id || req.body.hospitalId;
    const { headers, rows } = await rowsFromFile(req.file);
    const requiredHeaders = meta.columns.filter((column) => column[2]).map((column) => column[0]);
    const missing = requiredHeaders.filter((header) => !headers.includes(header));
    if (missing.length) return res.status(400).json({ success: false, message: `Missing required headers: ${missing.join(', ')}` });

    const mode = req.body.mode === 'UPDATE_BY_KEY' ? 'UPDATE_BY_KEY' : 'CREATE_ONLY';
    const result = [];
    const summary = { validNew: 0, validUpdates: 0, duplicates: 0, invalid: 0, warnings: 0, created: 0, updated: 0, skipped: 0 };

    for (const item of rows) {
      const prepared = await prepareData(entity, item.row, hospitalId, req.user._id);
      const { data, warnings } = prepared;
      const errors = [...prepared.errors];
      let action = 'create';
      let before = null;
      let target = null;

      if (!errors.length) {
        try {
          target = await existing(entity, data, hospitalId);
          errors.push(...await validateOperationalConstraints(entity, data, target));
          if (!errors.length) {
            if (target) {
              before = target.toObject ? target.toObject() : target;
              if (mode === 'UPDATE_BY_KEY') {
                action = 'update';
                summary.validUpdates += 1;
              } else {
                action = 'skip';
                summary.duplicates += 1;
              }
            } else {
              summary.validNew += 1;
            }
          }
        } catch (error) {
          errors.push(`Database lookup error: ${error.message}`);
        }
      }

      if (errors.length) {
        action = 'invalid';
        summary.invalid += 1;
      }
      summary.warnings += warnings.length;

      result.push({ rowNumber: item.rowNumber, action, naturalKey: natural(entity, data), errors, warnings, data, targetId: target?._id, before });
    }

    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const key = req.headers['idempotency-key'] || req.body.idempotencyKey || crypto.randomUUID();
    const job = await BulkImportJob.findOneAndUpdate(
      { hospitalId, entity, idempotencyKey: key },
      {
        hospitalId, entity, status: 'preview_ready', templateVersion: '2026.07.11', originalFileName: req.file.originalname,
        fileHash: hash, uploadedBy: req.user._id, mode, idempotencyKey: key, summary, rows: result
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, jobId: job._id, status: job.status, summary: job.summary, rows: job.rows });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.errors = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Import job not found' });
    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Import Result');
    worksheet.addRow(['Row', 'Action', 'Natural Key', 'Errors', 'Warnings']);
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    job.rows.forEach((row) => worksheet.addRow([
      row.rowNumber, row.action, safeSheet(row.naturalKey || ''),
      (row.errors || []).map(safeSheet).join('; '), (row.warnings || []).map(safeSheet).join('; ')
    ]));
    worksheet.columns.forEach((column) => { column.width = 24; });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${job.entity}-import-errors.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Errors export error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.commit = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Import job not found' });
    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });
    if (job.status === 'committed') return res.json({ success: true, idempotent: true, job });
    if (job.status !== 'preview_ready') return res.status(409).json({ success: false, message: `Job cannot be committed from status ${job.status}` });

    const invalidRows = job.rows.filter((row) => row.action === 'invalid');
    if (invalidRows.length) return res.status(400).json({ success: false, message: `Cannot commit: ${invalidRows.length} rows have validation errors. Download the validation workbook and fix them first.` });

    job.status = 'committing';
    await job.save();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of job.rows) {
      if (row.action === 'invalid' || row.action === 'skip') {
        skipped += 1;
        continue;
      }

      try {
        const current = await existing(job.entity, row.data, job.hospitalId);
        const operationalErrors = await validateOperationalConstraints(job.entity, row.data, current);
        if (operationalErrors.length) throw new Error(operationalErrors.join('; '));

        if (row.action === 'create' && !current) {
          const doc = await createEntityRecord(job.entity, row.data, req.user._id);
          row.targetId = doc._id;
          row.after = doc.toObject ? doc.toObject() : doc;
          created += 1;
        } else if (row.action === 'update' && current) {
          const result = await updateEntityRecord(job.entity, current, row.data, req.user._id);
          row.targetId = result.doc._id;
          row.before = result.before;
          row.after = result.doc.toObject ? result.doc.toObject() : result.doc;
          updated += 1;
        } else {
          row.action = 'skip';
          skipped += 1;
        }
      } catch (error) {
        row.errors = row.errors || [];
        row.errors.push(`Commit error: ${error.message}`);
        row.action = 'invalid';
        skipped += 1;
        console.error(`Error committing ${job.entity} row ${row.rowNumber}:`, error);
      }
    }

    job.summary.created = created;
    job.summary.updated = updated;
    job.summary.skipped = skipped;
    job.status = 'committed';
    job.committedBy = req.user._id;
    job.commitAt = new Date();
    await job.save();

    res.json({ success: true, job: { _id: job._id, status: job.status, summary: job.summary, entity: job.entity, committedBy: job.committedBy, commitAt: job.commitAt } });
  } catch (error) {
    console.error('Commit error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.history = async (req, res) => {
  try {
    const filter = req.user.role === 'mediqliq_super_admin' ? {} : { hospitalId: req.user.hospital_id };
    if (req.query.entity) filter.entity = req.query.entity;
    const jobs = await BulkImportJob.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit || 25), 100)).select('-rows -data');
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.rollback = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Import job not found' });
    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });
    if (job.status !== 'committed') return res.status(409).json({ success: false, message: 'Only committed import jobs can be rolled back' });

    const hoursSinceCommit = (Date.now() - new Date(job.commitAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCommit > 24) return res.status(409).json({ success: false, message: 'Rollback only allowed within 24 hours of commit' });

    const Model = modelFor(job.entity);
    if (!Model) throw new Error(`Model not found for entity: ${job.entity}`);
    let rolledBack = 0;
    const errors = [];

    for (const row of [...job.rows].reverse()) {
      try {
        if (row.action === 'create' && row.targetId) {
          const doc = await Model.findById(row.targetId);
          if (!doc) continue;
          if (job.entity === 'appointments') await removeAppointmentFromCalendar(doc);
          if (job.entity === 'ipd-admissions') {
            if (doc.bedId) await Bed.updateOne({ _id: doc.bedId, currentAdmissionId: doc._id }, { $set: { status: 'Available' }, $unset: { currentAdmissionId: 1 } });
            await Patient.updateOne({ _id: doc.patientId }, { $pull: { active_admissions: { admission_id: doc._id } } });
          }
          await Model.findByIdAndDelete(row.targetId);
          rolledBack += 1;
        } else if (row.action === 'update' && row.targetId && row.before) {
          const current = await Model.findById(row.targetId);
          if (!current) continue;
          if (job.entity === 'appointments') await removeAppointmentFromCalendar(current);
          const beforeData = { ...row.before };
          delete beforeData._id; delete beforeData.__v; delete beforeData.createdAt; delete beforeData.updatedAt;
          current.set(beforeData);
          await current.save({ validateBeforeSave: false });
          if (job.entity === 'appointments') await syncAppointmentCalendar(current, 10);
          if (job.entity === 'ipd-admissions') await applyAdmissionSideEffects(current);
          rolledBack += 1;
        }
      } catch (error) {
        errors.push(`Row ${row.rowNumber}: ${error.message}`);
        console.error(`Rollback error for row ${row.rowNumber}:`, error);
      }
    }

    job.status = 'rolled_back';
    job.rollbackAt = new Date();
    job.rolledBackBy = req.user._id;
    job.error = errors.length ? errors.join(' | ') : undefined;
    await job.save();
    res.json({ success: true, jobId: job._id, status: job.status, rolledBack, errors: errors.length ? errors : undefined });
  } catch (error) {
    console.error('Rollback error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
