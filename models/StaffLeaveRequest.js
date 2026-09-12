const mongoose = require('mongoose');

const staffLeaveRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  leave_type: { type: String, enum: ['casual', 'sick', 'earned', 'maternity', 'paternity', 'unpaid', 'other'], default: 'casual' },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  start_date_key: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  end_date_key: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  leave_timezone: { type: String, default: 'Asia/Kolkata' },
  total_days: { type: Number, default: 1, min: 0.5 },
  is_paid_leave: { type: Boolean, default: true },
  paid_days: { type: Number, default: 0, min: 0 },
  unpaid_days: { type: Number, default: 0, min: 0 },
  reason: { type: String, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approved_at: { type: Date },
  rejection_reason: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

staffLeaveRequestSchema.pre('save', function(next) {
  if (this.start_date_key && this.end_date_key) {
    const start = new Date(`${this.start_date_key}T12:00:00.000Z`);
    const end = new Date(`${this.end_date_key}T12:00:00.000Z`);
    const diff = Math.max(0, end.getTime() - start.getTime());
    this.total_days = Math.floor(diff / 86400000) + 1;
  }
  next();
});

staffLeaveRequestSchema.index({ employee_id: 1, start_date: -1 });
staffLeaveRequestSchema.index({ employee_id: 1, start_date_key: 1, end_date_key: 1 });
staffLeaveRequestSchema.index({ hospital_id: 1, status: 1 });

module.exports = mongoose.model('StaffLeaveRequest', staffLeaveRequestSchema);
