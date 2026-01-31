const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
  doctor_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Doctor', 
    required: true 
  },
  period_type: { 
    type: String, 
    enum: ['daily', 'monthly', 'yearly'], 
    required: true 
  },
  period_start: { type: Date, required: true },
  period_end: { type: Date, required: true },
  amount: { type: Number, required: true, min: 0 },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'paid', 'cancelled'], 
    default: 'pending' 
  },
  payment_method: { 
    type: String, 
    enum: ['bank_transfer', 'cash', 'cheque', 'online'], 
    default: 'bank_transfer' 
  },
  appointment_count: { type: Number, default: 0 },
  appointments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }], // Track processed appointments
  total_hours: { type: Number, default: 0 }, // For hourly doctors
  base_salary: { type: Number, default: 0 }, // For full-time doctors
  bonus: { type: Number, default: 0 },
  deductions: { type: Number, default: 0 },
  net_amount: { type: Number, required: true },
  notes: { type: String },
  paid_date: { type: Date },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { timestamps: true });

// Index for efficient queries
salarySchema.index({ doctor_id: 1, period_start: 1, period_end: 1 });
salarySchema.index({ status: 1, period_type: 1 });

module.exports = mongoose.model('Salary', salarySchema);