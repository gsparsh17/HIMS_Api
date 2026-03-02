// models/Salary.js
const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
  doctor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    required: true
  },

  // ✅ NEW: distinguish salary vs commission in DB
  earning_type: {
    type: String,
    enum: ['salary', 'commission'],
    required: true,
    default: 'salary'
  },

  period_type: {
    type: String,
    // ✅ FIX: weekly was missing
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
    required: true
  },
  period_start: { type: Date, required: true },
  period_end: { type: Date, required: true },

  // For salary: amount = base/net
  // For commission: amount = doctor_share
  amount: { type: Number, required: true, min: 0 },

  // ✅ FIX: code uses hold + processing
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'cancelled', 'hold'],
    default: 'pending'
  },

  payment_method: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'online', 'upi'],
    default: 'bank_transfer'
  },

  appointment_count: { type: Number, default: 0 },
  appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],

  total_hours: { type: Number, default: 0 },

  // ✅ Salary-only
  base_salary: { type: Number, default: 0 },
  bonus: { type: Number, default: 0 },
  deductions: { type: Number, default: 0 },

  // ✅ Commission-only (stored so frontend shows correct values)
  gross_amount: { type: Number, default: 0 },        // total appointment fees
  doctor_share: { type: Number, default: 0 },        // doctor commission
  hospital_share: { type: Number, default: 0 },      // hospital revenue
  revenue_percentage: { type: Number, default: 100 },// snapshot % at that time

  net_amount: { type: Number, required: true },

  notes: { type: String },
  paid_date: { type: Date },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }

}, { timestamps: true });

salarySchema.index({ doctor_id: 1, period_start: 1, period_end: 1 });
salarySchema.index({ status: 1, period_type: 1 });
salarySchema.index({ earning_type: 1, doctor_id: 1 });

module.exports = mongoose.model('Salary', salarySchema);