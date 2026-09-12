const mongoose = require('mongoose');
const { addSoftDeleteFields } = require('../utils/softDelete');
const { DEFAULT_HOSPITAL_TIME_ZONE } = require('../utils/hospitalDateTime');

const intervalSchema = new mongoose.Schema({
  start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  shift_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift' },
  label: { type: String, trim: true },
  spans_next_day: { type: Boolean, default: false }
}, { _id: true });

const daySchema = new mongoose.Schema({
  day: {
    type: String,
    required: true,
    enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  },
  enabled: { type: Boolean, default: false },
  intervals: { type: [intervalSchema], default: [] }
}, { _id: false });

const exceptionSchema = new mongoose.Schema({
  date_key: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  type: { type: String, enum: ['OFF', 'OVERRIDE', 'EXTRA_AVAILABILITY'], required: true },
  intervals: { type: [intervalSchema], default: [] },
  reason: { type: String, trim: true }
}, { _id: true });

const staffScheduleSchema = new mongoose.Schema({
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true, index: true },
  timezone: { type: String, default: DEFAULT_HOSPITAL_TIME_ZONE, trim: true },
  effective_from: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  effective_to: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  weekly: { type: [daySchema], default: [] },
  exceptions: { type: [exceptionSchema], default: [] },
  source: { type: String, enum: ['manual', 'migration', 'legacy_import'], default: 'manual' },
  version: { type: Number, default: 1, min: 1 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

staffScheduleSchema.index(
  { hospital_id: 1, employee_id: 1, is_active: 1 },
  { unique: true, partialFilterExpression: { is_active: true } }
);
staffScheduleSchema.index({ hospital_id: 1, effective_from: 1, effective_to: 1 });

addSoftDeleteFields(staffScheduleSchema);

module.exports = mongoose.model('StaffSchedule', staffScheduleSchema);
