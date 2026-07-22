const mongoose = require('mongoose');

const otScheduleSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  otRoomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true
  },
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OTRequest',
    required: true,
    unique: true
  },
  scheduledDate: { type: Date, required: true },
  startTime: String,
  endTime: String,
  scheduledStart: { type: Date, required: true, index: true },
  scheduledEnd: { type: Date, required: true, index: true },
  setupBufferMinutes: { type: Number, default: 15 },
  cleaningBufferMinutes: { type: Number, default: 20 },
  conflictKey: { type: String, trim: true, index: true },
  version: { type: Number, default: 1 },
  duration_minutes: { type: Number, default: 60 },
  status: {
    type: String,
    enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Rescheduled'],
    default: 'Scheduled'
  },
  notes: String,
  teamSnapshot: [{ role: String, userId: mongoose.Schema.Types.ObjectId, name: String }],
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

otScheduleSchema.index({ hospitalId: 1, otRoomId: 1, scheduledStart: 1, scheduledEnd: 1 });
otScheduleSchema.index({ requestId: 1 });
otScheduleSchema.index({ hospitalId: 1, scheduledDate: 1, status: 1 });

module.exports = mongoose.model('OTSchedule', otScheduleSchema);