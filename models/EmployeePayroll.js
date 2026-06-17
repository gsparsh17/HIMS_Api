const mongoose = require('mongoose');

const payrollLineSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  amount: { type: Number, default: 0 },
  taxable: { type: Boolean, default: true }
}, { _id: false });

function makePayrollCode(doc) {
  const date = doc.period_start ? new Date(doc.period_start) : new Date();
  const y = doc.year || date.getFullYear();
  const m = doc.month || date.getMonth() + 1;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `PAY-${y}-${String(m).padStart(2, '0')}-${rand}`;
}

const employeePayrollSchema = new mongoose.Schema({
  payroll_code: { type: String, unique: true, sparse: true, trim: true },
  legacy_salary_id: { type: mongoose.Schema.Types.ObjectId, index: true, unique: true, sparse: true },

  // Unified HR employee reference. All generated payroll should point here.
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', index: true },
  hr_staff_profile_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', index: true },

  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },

  // Source master record from which this payroll belongs.
  source_model: {
    type: String,
    enum: ['Doctor', 'Staff', 'Nurse', 'LabStaff', 'PathologyStaff', 'RadiologyStaff', 'OTStaff', 'Manual'],
    index: true
  },
  source_id: { type: mongoose.Schema.Types.ObjectId, index: true },

  // Backward-compatible doctor salary field. Existing /api/salaries controllers use this.
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', index: true },
  staff_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Staff', index: true },
  nurse_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Nurse', index: true },
  role: { type: String, trim: true },
  employee_name: { type: String, trim: true },
  employee_code: { type: String, trim: true },
  staff_type: { type: String, trim: true, index: true },
  role: { type: String, trim: true },
  designation: { type: String, trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  department_name: { type: String, trim: true },

  // Unified category. This replaces the old split between HRPayroll and Salary.
  payroll_category: {
    type: String,
    enum: ['fixed_salary', 'contractual_salary', 'doctor_commission', 'per_visit', 'hourly', 'manual_adjustment'],
    default: 'fixed_salary',
    index: true
  },

  // Old Salary compatibility: salary|commission.
  earning_type: {
    type: String,
    enum: ['salary', 'commission'],
    default: 'salary',
    index: true
  },

  salary_type: {
    type: String,
    enum: ['Salary', 'Per Hour', 'Fee per Visit', 'Contractual Salary', 'Commission'],
    default: 'Salary'
  },

  period_type: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
    required: true,
    default: 'monthly',
    index: true
  },
  month: { type: Number, min: 1, max: 12 },
  year: { type: Number },
  period_start: { type: Date, required: true, index: true },
  period_end: { type: Date, required: true, index: true },

  // Unified money fields.
  base_salary: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 }, // legacy Salary amount
  gross_amount: { type: Number, default: 0, min: 0 },
  gross_salary: { type: Number, default: 0, min: 0 }, // legacy HRPayroll gross
  allowances: [payrollLineSchema],
  bonus: { type: Number, default: 0, min: 0 },
  deductions: [payrollLineSchema],
  deduction_amount: { type: Number, default: 0, min: 0 },
  total_deductions: { type: Number, default: 0, min: 0 },
  leave_deductions: { type: Number, default: 0, min: 0 },
  net_amount: { type: Number, default: 0, min: 0 },
  net_salary: { type: Number, default: 0, min: 0 }, // legacy HRPayroll net

  // Attendance / leave details for fixed employees.
  total_working_days: { type: Number, default: 0, min: 0 },
  payable_days: { type: Number, default: 0, min: 0 },
  present_days: { type: Number, default: 0, min: 0 },
  paid_leave_days: { type: Number, default: 0, min: 0 },
  unpaid_leave_days: { type: Number, default: 0, min: 0 },
  absent_days: { type: Number, default: 0, min: 0 },
  late_days: { type: Number, default: 0, min: 0 },
  total_hours: { type: Number, default: 0, min: 0 },

  attendance_details: {
    total_days: { type: Number, default: 0 },
    present_days: { type: Number, default: 0 },
    paid_leave_days: { type: Number, default: 0 },
    unpaid_leave_days: { type: Number, default: 0 },
    absent_days: { type: Number, default: 0 },
    late_days: { type: Number, default: 0 },
    total_hours: { type: Number, default: 0 }
  },

  // Doctor commission / appointment based details.
  appointment_count: { type: Number, default: 0, min: 0 },
  appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  doctor_share: { type: Number, default: 0, min: 0 },
  hospital_share: { type: Number, default: 0, min: 0 },
  revenue_percentage: { type: Number, default: 100, min: 0 },
  commission_details: {
    appointment_count: { type: Number, default: 0 },
    appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
    total_appointment_fees: { type: Number, default: 0 },
    doctor_share: { type: Number, default: 0 },
    hospital_share: { type: Number, default: 0 },
    revenue_percentage: { type: Number, default: 100 },
    total_hours: { type: Number, default: 0 },
    rate: { type: Number, default: 0 }
  },

  status: {
    type: String,
    enum: ['draft', 'generated', 'approved', 'pending', 'processing', 'paid', 'cancelled', 'hold'],
    default: 'pending',
    index: true
  },

  clearance_status: {
    type: String,
    enum: ['not_required', 'pending', 'cleared', 'rejected', 'blocked'],
    default: 'pending',
    index: true
  },
  clearance_requested_at: { type: Date },
  cleared_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cleared_at: { type: Date },
  clearance_note: { type: String, trim: true },
  clearance_notes: { type: String, trim: true },

  payment_method: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'online', 'upi'],
    default: 'bank_transfer'
  },
  payment_reference: { type: String, trim: true },
  paid_date: { type: Date },

  notes: { type: String },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

employeePayrollSchema.pre('validate', async function (next) {
  try {
    if (!this.payroll_code) this.payroll_code = makePayrollCode(this);

    if (this.doctor_id && !this.source_model) this.source_model = 'Doctor';
    if (this.doctor_id && !this.source_id) this.source_id = this.doctor_id;
    if (this.employee_id && !this.hr_staff_profile_id) this.hr_staff_profile_id = this.employee_id;
    if (this.hr_staff_profile_id && !this.employee_id) this.employee_id = this.hr_staff_profile_id;

    if (!this.month || !this.year) {
      const d = this.period_start ? new Date(this.period_start) : new Date();
      if (!this.month) this.month = d.getMonth() + 1;
      if (!this.year) this.year = d.getFullYear();
    }

    if (!this.period_type) this.period_type = this.month ? 'monthly' : 'daily';

    if (!this.payroll_category) {
      if (this.earning_type === 'commission') this.payroll_category = 'doctor_commission';
      else if (this.salary_type === 'Contractual Salary') this.payroll_category = 'contractual_salary';
      else if (this.salary_type === 'Per Hour') this.payroll_category = 'hourly';
      else if (this.salary_type === 'Fee per Visit') this.payroll_category = 'per_visit';
      else this.payroll_category = 'fixed_salary';
    }

    if (['doctor_commission', 'per_visit', 'hourly'].includes(this.payroll_category)) {
      this.earning_type = 'commission';
    } else if (!this.earning_type) {
      this.earning_type = 'salary';
    }

    // Attach HR profile automatically when a doctor commission/salary is created through old salary APIs.
    if ((!this.employee_id || !this.hospital_id || !this.employee_name) && this.source_model && this.source_id) {
      try {
        const HRStaffProfile = require('./HRStaffProfile');
        const profile = await HRStaffProfile.findOne({ source_model: this.source_model, source_id: this.source_id });
        if (profile) {
          if (!this.employee_id) this.employee_id = profile._id;
          if (!this.hr_staff_profile_id) this.hr_staff_profile_id = profile._id;
          if (!this.hospital_id && profile.hospital_id) this.hospital_id = profile.hospital_id;
          if (!this.user_id && profile.user_id) this.user_id = profile.user_id;
          if (!this.employee_name) this.employee_name = profile.full_name;
          if (!this.employee_code) this.employee_code = profile.employee_code;
          if (!this.staff_type) this.staff_type = profile.staff_type;
          if (!this.designation) this.designation = profile.designation;
          if (!this.department && profile.department) this.department = profile.department;
          if (!this.department_name) this.department_name = profile.department_name;
        }
      } catch (profileError) {
        // Do not block payroll creation when HR profile is not available yet.
      }
    }

    const allowanceTotal = (this.allowances || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const deductionLineTotal = (this.deductions || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);

    if (this.commission_details) {
      if (!this.appointment_count && this.commission_details.appointment_count) this.appointment_count = this.commission_details.appointment_count;
      if ((!this.appointments || !this.appointments.length) && this.commission_details.appointments?.length) this.appointments = this.commission_details.appointments;
      if (!this.gross_amount && this.commission_details.total_appointment_fees) this.gross_amount = this.commission_details.total_appointment_fees;
      if (!this.doctor_share && this.commission_details.doctor_share) this.doctor_share = this.commission_details.doctor_share;
      if (!this.hospital_share && this.commission_details.hospital_share) this.hospital_share = this.commission_details.hospital_share;
      if (this.commission_details.revenue_percentage !== undefined) this.revenue_percentage = this.commission_details.revenue_percentage;
    }

    if (!this.gross_salary) this.gross_salary = Math.max(0, Number(this.base_salary || this.amount || 0) + allowanceTotal + Number(this.bonus || 0));
    if (!this.gross_amount) this.gross_amount = this.gross_salary || this.amount || this.doctor_share || 0;
    if ((this.deductions || []).length) {
      this.total_deductions = Math.max(0, deductionLineTotal);
    } else {
      this.total_deductions = Math.max(0, Number(this.total_deductions || this.deduction_amount || 0) + Number(this.leave_deductions || 0));
    }
    if (!this.deduction_amount) this.deduction_amount = this.total_deductions;

    if (!this.net_salary || this.isModified('gross_salary') || this.isModified('deductions') || this.isModified('total_deductions') || this.isModified('base_salary') || this.isModified('bonus')) {
      this.net_salary = Math.max(0, Number(this.gross_salary || this.gross_amount || this.amount || 0) - Number(this.total_deductions || 0));
    }
    if (!this.net_amount) this.net_amount = this.net_salary;
    if (!this.amount) this.amount = this.net_amount || this.net_salary || this.doctor_share || this.base_salary || 0;

    if (this.earning_type === 'commission') {
      if (!this.doctor_share) this.doctor_share = this.net_amount || this.amount || 0;
      if (!this.commission_details) this.commission_details = {};
      this.commission_details.appointment_count = this.appointment_count || this.commission_details.appointment_count || 0;
      this.commission_details.appointments = this.appointments?.length ? this.appointments : this.commission_details.appointments;
      this.commission_details.total_appointment_fees = this.gross_amount || this.commission_details.total_appointment_fees || 0;
      this.commission_details.doctor_share = this.doctor_share || this.commission_details.doctor_share || 0;
      this.commission_details.hospital_share = this.hospital_share || this.commission_details.hospital_share || 0;
      this.commission_details.revenue_percentage = this.revenue_percentage ?? this.commission_details.revenue_percentage ?? 100;
      this.commission_details.total_hours = this.total_hours || this.commission_details.total_hours || 0;
    }

    this.attendance_details = {
      total_days: this.total_working_days || this.attendance_details?.total_days || 0,
      present_days: this.present_days || this.attendance_details?.present_days || 0,
      paid_leave_days: this.paid_leave_days || this.attendance_details?.paid_leave_days || 0,
      unpaid_leave_days: this.unpaid_leave_days || this.attendance_details?.unpaid_leave_days || 0,
      absent_days: this.absent_days || this.attendance_details?.absent_days || 0,
      late_days: this.late_days || this.attendance_details?.late_days || 0,
      total_hours: this.total_hours || this.attendance_details?.total_hours || 0
    };

    next();
  } catch (error) {
    next(error);
  }
});

employeePayrollSchema.index({ hospital_id: 1, year: 1, month: 1, status: 1 });
employeePayrollSchema.index({ source_model: 1, source_id: 1, period_start: 1, period_end: 1 });
employeePayrollSchema.index({ doctor_id: 1, period_start: 1, period_end: 1 });
employeePayrollSchema.index({ status: 1, period_type: 1 });
employeePayrollSchema.index({ earning_type: 1, doctor_id: 1 });
employeePayrollSchema.index({ payroll_category: 1, source_model: 1 });
employeePayrollSchema.index({ clearance_status: 1, status: 1 });
employeePayrollSchema.index(
  { employee_id: 1, period_start: 1, period_end: 1, earning_type: 1 },
  { unique: true, partialFilterExpression: { status: { $nin: ['cancelled', 'rejected'] } } }
);
employeePayrollSchema.index(
  { appointments: 1 },
  { unique: true, partialFilterExpression: { earning_type: 'commission', status: { $nin: ['cancelled', 'rejected'] } } }
);

module.exports = mongoose.model('EmployeePayroll', employeePayrollSchema);
