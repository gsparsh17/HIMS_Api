const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const { DEFAULT_HOSPITAL_TIME_ZONE } = require('../utils/hospitalDateTime');

const calendarEventSchema = new mongoose.Schema({
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', index: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', index: true },
  date_key: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  type: {
    type: String,
    required: true,
    enum: ['BREAK', 'BLOCK', 'EXTRA_AVAILABILITY', 'SCHEDULE_OVERRIDE']
  },
  start_time: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  end_time: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  timezone: { type: String, default: DEFAULT_HOSPITAL_TIME_ZONE, trim: true },
  reason: { type: String, trim: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

calendarEventSchema.index({ hospital_id: 1, doctor_id: 1, date_key: 1, type: 1 });
calendarEventSchema.index({ hospital_id: 1, employee_id: 1, date_key: 1, type: 1 });

addSoftDeleteFields(calendarEventSchema);

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
