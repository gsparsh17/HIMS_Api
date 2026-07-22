const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  name: { type: String, required: true },
  reportKey: { type: String, required: true },
  filters: { type: mongoose.Schema.Types.Mixed, default: {} },
  format: { type: String, enum: ['csv', 'xlsx', 'pdf'], default: 'pdf' },
  frequency: { type: String, enum: ['Daily', 'Weekly', 'Monthly'], default: 'Monthly' },
  timeOfDay: { type: String, default: '07:00' },
  dayOfWeek: { type: Number, min: 0, max: 6 },
  dayOfMonth: { type: Number, min: 1, max: 31 },
  recipients: [{ type: String, trim: true, lowercase: true }],
  isActive: { type: Boolean, default: true, index: true },
  nextRunAt: { type: Date, index: true },
  lastRunAt: Date,
  lastStatus: String,
  lastExportJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'MISExportJob' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
module.exports = mongoose.model('MISSchedule', schema);
