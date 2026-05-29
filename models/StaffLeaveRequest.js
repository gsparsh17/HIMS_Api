const mongoose = require('mongoose');

const staffLeaveRequestSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  leave_type: { type: String, enum: ['casual', 'sick', 'earned', 'maternity', 'paternity', 'unpaid', 'other'], default: 'casual' },
  start_date: { type: Date, required: true },
  end_date: { type: Date, required: true },
  total_days: { type: Number, default: 1, min: 0.5 },
  reason: { type: String, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approved_at: { type: Date },
  rejection_reason: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

staffLeaveRequestSchema.pre('save', function(next) {
  if (this.start_date && this.end_date) {
    const start = new Date(this.start_date); start.setHours(0, 0, 0, 0);
    const end = new Date(this.end_date); end.setHours(0, 0, 0, 0);
    const diff = Math.max(0, end.getTime() - start.getTime());
    this.total_days = Math.floor(diff / 86400000) + 1;
  }
  next();
});

staffLeaveRequestSchema.index({ employee_id: 1, start_date: -1 });
staffLeaveRequestSchema.index({ hospital_id: 1, status: 1 });

module.exports = mongoose.model('StaffLeaveRequest', staffLeaveRequestSchema);
