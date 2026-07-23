const mongoose = require('mongoose');

function makeEmployeeCode() {
  const y = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `EMP-${y}-${rand}`;
}

const hrStaffProfileSchema = new mongoose.Schema({
  employee_code: { type: String, trim: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff' },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  nurse_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Nurse' },
  lab_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LabStaff' },
  pathology_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PathologyStaff' },
  radiology_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'RadiologyStaff' },
  ot_staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'OTStaff' },
  source_model: {
    type: String,
    enum: ['Doctor', 'Staff', 'Nurse', 'LabStaff', 'PathologyStaff', 'RadiologyStaff', 'OTStaff', 'Manual']
  },
  source_id: { type: mongoose.Schema.Types.ObjectId },
  full_name: { type: String, required: true, trim: true },
  first_name: { type: String, trim: true },
  last_name: { type: String, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  gender: { type: String, enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
  date_of_birth: { type: Date },
  address: { type: String, trim: true },
  staff_type: {
    type: String,
    enum: [
      'doctor',
      'nurse',
      'staff',
      'admin',
      'hr',
      'store',
      'pharmacy',
      'pathology_staff',
      'radiology_staff',
      'ot_staff',
      'receptionist',
      'registrar',
      'accountant',
      'insurance_desk',
      'bed_manager',
      'housekeeping',
      'other'
    ],
    default: 'staff'
  },
  designation: { type: String, required: true, trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  department_name: { type: String, trim: true },
  specialization: { type: String, trim: true },
  qualification: { type: String, trim: true },
  license_number: { type: String, trim: true },
  shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  joining_date: { type: Date, default: Date.now },
  employment_type: {
    type: String,
    enum: ['Full Time', 'Part Time', 'Contract', 'Visiting', 'Intern', 'Temporary'],
    default: 'Full Time'
  },
  employment_status: {
    type: String,
    enum: ['Active', 'Inactive', 'On Leave', 'Suspended', 'Terminated'],
    default: 'Active'
  },
  salary_type: {
    type: String,
    enum: ['Salary', 'Per Hour', 'Fee per Visit', 'Contractual Salary', 'Commission'],
    default: 'Salary'
  },
  salary_amount: { type: Number, default: 0, min: 0 },
  payroll_enabled: { type: Boolean, default: true },
  pay_cycle: {
    type: String,
    enum: ['monthly', 'weekly', 'daily'],
    default: 'monthly'
  },
  basic_salary: { type: Number, default: 0, min: 0 },
  hra: { type: Number, default: 0, min: 0 },
  conveyance_allowance: { type: Number, default: 0, min: 0 },
  medical_allowance: { type: Number, default: 0, min: 0 },
  other_allowance: { type: Number, default: 0, min: 0 },
  pf_deduction: { type: Number, default: 0, min: 0 },
  esi_deduction: { type: Number, default: 0, min: 0 },
  professional_tax: { type: Number, default: 0, min: 0 },
  tds: { type: Number, default: 0, min: 0 },
  other_deduction: { type: Number, default: 0, min: 0 },
  paid_leave_quota: { type: Number, default: 0, min: 0 },
  unpaid_leave_policy: {
    type: String,
    enum: ['deduct_per_day', 'ignore'],
    default: 'deduct_per_day'
  },
  bank_name: { type: String, trim: true },
  bank_account_number: { type: String, trim: true },
  ifsc_code: { type: String, trim: true },
  aadhar_number: { type: String, trim: true },
  pan_number: { type: String, trim: true },
  emergency_contact_name: { type: String, trim: true },
  emergency_contact_phone: { type: String, trim: true },
  login_enabled: { type: Boolean, default: false },
  availability_status: {
    type: String,
    enum: ['available', 'busy', 'on_leave', 'off_duty', 'in_ot', 'in_ward', 'in_opd', 'emergency', 'unavailable'],
    default: 'available'
  },
  availability_note: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

hrStaffProfileSchema.pre('save', function(next) {
  if (!this.employee_code) {
    this.employee_code = makeEmployeeCode();
  }

  if (!this.first_name && this.full_name) {
    const [first, ...rest] = this.full_name.trim().split(/\s+/);
    this.first_name = first;
    this.last_name = rest.join(' ');
  }

  next();
});

hrStaffProfileSchema.index({ hospital_id: 1, employee_code: 1 }, { unique: true });
hrStaffProfileSchema.index({ hospital_id: 1, email: 1 }, { unique: true });
hrStaffProfileSchema.index({ staff_type: 1, employment_status: 1 });
hrStaffProfileSchema.index({ department: 1 });
hrStaffProfileSchema.index({ user_id: 1 });
hrStaffProfileSchema.index({ source_model: 1, source_id: 1 }, { unique: true, sparse: true });
hrStaffProfileSchema.index({ payroll_enabled: 1, employment_status: 1 });

module.exports = mongoose.model('HRStaffProfile', hrStaffProfileSchema);