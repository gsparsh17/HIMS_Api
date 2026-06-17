/*
  One-time migration for Option A unified payroll.

  It copies existing documents from the legacy `salaries` collection into the new
  `employeepayrolls` collection used by EmployeePayroll. It is idempotent: records
  with the same legacy_salary_id are skipped.

  Usage:
    node scripts/migrateSalaryToEmployeePayroll.js
*/
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const connectDB = require('../config/db');
const EmployeePayroll = require('../models/EmployeePayroll');
const HRStaffProfile = require('../models/HRStaffProfile');
const Doctor = require('../models/Doctor');

function toDate(value, fallback = new Date()) {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function inferPayrollCategory(salary, doctor) {
  if (salary.earning_type === 'commission') {
    if (doctor?.paymentType === 'Per Hour') return 'hourly';
    if (doctor?.paymentType === 'Fee per Visit') return 'per_visit';
    return 'doctor_commission';
  }
  if (doctor?.paymentType === 'Contractual Salary') return 'contractual_salary';
  return 'fixed_salary';
}

async function run() {
  await connectDB();
  const legacyCollection = mongoose.connection.collection('salaries');
  const legacyCount = await legacyCollection.countDocuments();
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  const cursor = legacyCollection.find({});
  while (await cursor.hasNext()) {
    const salary = await cursor.next();
    try {
      const exists = await EmployeePayroll.findOne({ legacy_salary_id: salary._id });
      if (exists) {
        skipped += 1;
        continue;
      }

      const doctor = salary.doctor_id ? await Doctor.findById(salary.doctor_id) : null;
      const profile = salary.doctor_id
        ? await HRStaffProfile.findOne({ source_model: 'Doctor', source_id: salary.doctor_id })
        : null;

      const periodStart = toDate(salary.period_start);
      const periodEnd = toDate(salary.period_end, periodStart);
      const payroll = new EmployeePayroll({
        legacy_salary_id: salary._id,
        employee_id: profile?._id,
        hr_staff_profile_id: profile?._id,
        user_id: profile?.user_id,
        hospital_id: profile?.hospital_id,
        source_model: 'Doctor',
        source_id: salary.doctor_id,
        doctor_id: salary.doctor_id,
        employee_name: profile?.full_name || (doctor ? `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() : undefined),
        employee_code: profile?.employee_code,
        staff_type: 'doctor',
        designation: 'Doctor',
        department: profile?.department || doctor?.department,
        payroll_category: inferPayrollCategory(salary, doctor),
        earning_type: salary.earning_type || 'salary',
        salary_type: doctor?.paymentType || (salary.earning_type === 'commission' ? 'Commission' : 'Salary'),
        period_type: salary.period_type || 'monthly',
        month: periodStart.getMonth() + 1,
        year: periodStart.getFullYear(),
        period_start: periodStart,
        period_end: periodEnd,
        base_salary: salary.base_salary || 0,
        amount: salary.amount || 0,
        gross_amount: salary.gross_amount || salary.amount || 0,
        gross_salary: salary.gross_amount || salary.base_salary || salary.amount || 0,
        bonus: salary.bonus || 0,
        deduction_amount: salary.deductions || 0,
        total_deductions: salary.deductions || 0,
        net_amount: salary.net_amount || salary.amount || 0,
        net_salary: salary.net_amount || salary.amount || 0,
        appointment_count: salary.appointment_count || 0,
        appointments: salary.appointments || [],
        total_hours: salary.total_hours || 0,
        doctor_share: salary.doctor_share || 0,
        hospital_share: salary.hospital_share || 0,
        revenue_percentage: salary.revenue_percentage || 100,
        commission_details: {
          appointment_count: salary.appointment_count || 0,
          appointments: salary.appointments || [],
          total_appointment_fees: salary.gross_amount || 0,
          doctor_share: salary.doctor_share || salary.amount || 0,
          hospital_share: salary.hospital_share || 0,
          revenue_percentage: salary.revenue_percentage || 100,
          total_hours: salary.total_hours || 0,
          rate: doctor?.amount || 0
        },
        status: salary.status || 'pending',
        clearance_status: salary.status === 'paid' ? 'cleared' : 'pending',
        payment_method: salary.payment_method || 'bank_transfer',
        paid_date: salary.paid_date,
        notes: salary.notes,
        created_by: salary.created_by,
        createdAt: salary.createdAt,
        updatedAt: salary.updatedAt
      });

      await payroll.save();
      migrated += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed to migrate salary ${salary._id}:`, error.message);
    }
  }

  console.log(JSON.stringify({ legacyCount, migrated, skipped, failed }, null, 2));
  await mongoose.connection.close();
}

run().catch(async (error) => {
  console.error(error);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
