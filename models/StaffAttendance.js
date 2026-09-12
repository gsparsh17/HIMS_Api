const mongoose = require('mongoose');

const staffAttendanceSchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  attendance_date: { type: Date, required: true },
  attendance_date_key: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  attendance_timezone: { type: String, default: 'Asia/Kolkata' },
  check_in: { type: Date },
  check_out: { type: Date },
  segments: [{
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
    scheduled_start: { type: String },
    scheduled_end: { type: String },
    check_in: { type: Date },
    check_out: { type: Date },
    break_minutes: { type: Number, default: 0, min: 0 }
  }],
  break_minutes: { type: Number, default: 0, min: 0 },
  total_minutes: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['present', 'absent', 'half_day', 'late', 'leave', 'week_off', 'holiday'],
    default: 'present'
  },
  attendance_source: { type: String, enum: ['hr', 'self', 'biometric', 'import'], default: 'hr' },
  shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  location: { type: String, trim: true },
  remarks: { type: String, trim: true },
  approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reconciliation_status: { type: String, enum: ['not_required', 'pending', 'reconciled', 'exception', 'approved'], default: 'not_required' },
  reconciliation_exceptions: [String],
  raw_punch_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AttendancePunch' }],
}, { timestamps: true });

staffAttendanceSchema.pre('save', function(next) {
  if (Array.isArray(this.segments) && this.segments.length) {
    this.total_minutes = this.segments.reduce((sum, segment) => {
      if (!segment.check_in || !segment.check_out) return sum;
      const diff = Math.max(0, segment.check_out.getTime() - segment.check_in.getTime());
      return sum + Math.max(0, Math.round(diff / 60000) - Number(segment.break_minutes || 0));
    }, 0);
  } else if (this.check_in && this.check_out) {
    const diff = Math.max(0, this.check_out.getTime() - this.check_in.getTime());
    this.total_minutes = Math.max(0, Math.round(diff / 60000) - Number(this.break_minutes || 0));
  }
  next();
});

staffAttendanceSchema.index({ employee_id: 1, attendance_date_key: 1 }, { unique: true, partialFilterExpression: { attendance_date_key: { $type: 'string' } } });
staffAttendanceSchema.index({ employee_id: 1, attendance_date: 1 });
staffAttendanceSchema.index({ hospital_id: 1, attendance_date: -1 });
staffAttendanceSchema.index({ status: 1 });

module.exports = mongoose.model('StaffAttendance', staffAttendanceSchema);
