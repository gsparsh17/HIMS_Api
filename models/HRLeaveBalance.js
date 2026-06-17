const mongoose = require('mongoose');

const hrLeaveBalanceSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  year: { type: Number, required: true },
  leave_type: { type: String, enum: ['casual', 'sick', 'earned', 'maternity', 'paternity', 'unpaid', 'other'], required: true },
  opening_balance: { type: Number, default: 0, min: 0 },
  accrued: { type: Number, default: 0, min: 0 },
  used: { type: Number, default: 0, min: 0 },
  adjusted: { type: Number, default: 0 },
  paid_leave: { type: Boolean, default: true },
  notes: { type: String, trim: true },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

hrLeaveBalanceSchema.virtual('available').get(function() {
  return Math.max(0, Number(this.opening_balance || 0) + Number(this.accrued || 0) + Number(this.adjusted || 0) - Number(this.used || 0));
});

hrLeaveBalanceSchema.set('toJSON', { virtuals: true });
hrLeaveBalanceSchema.set('toObject', { virtuals: true });
hrLeaveBalanceSchema.index({ employee_id: 1, year: 1, leave_type: 1 }, { unique: true });
hrLeaveBalanceSchema.index({ hospital_id: 1, year: 1 });

module.exports = mongoose.model('HRLeaveBalance', hrLeaveBalanceSchema);
