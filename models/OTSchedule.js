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
    required: true
  },
  scheduledDate: { type: Date, required: true },
  startTime: String,
  endTime: String,
  scheduledStart: { type: Date, required: true, index: true },
  scheduledEnd: { type: Date, required: true, index: true },
  blockedStart: { type: Date, index: true },
  blockedEnd: { type: Date, index: true },
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
  rescheduleReason: String,
  history: [{
    version: Number,
    status: String,
    otRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    scheduledStart: Date,
    scheduledEnd: Date,
    blockedStart: Date,
    blockedEnd: Date,
    setupBufferMinutes: Number,
    cleaningBufferMinutes: Number,
    duration_minutes: Number,
    teamSnapshot: [{ role: String, resourceType: String, userId: mongoose.Schema.Types.ObjectId, name: String }],
    changedAt: Date,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String
  }],
  teamSnapshot: [{ role: String, resourceType: String, userId: mongoose.Schema.Types.ObjectId, name: String }],
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

otScheduleSchema.index({ hospitalId: 1, otRoomId: 1, scheduledStart: 1, scheduledEnd: 1 });
otScheduleSchema.index({ hospitalId: 1, otRoomId: 1, status: 1, blockedStart: 1, blockedEnd: 1 });
otScheduleSchema.index({ requestId: 1 }, { unique: true, name: 'requestId_1' });
otScheduleSchema.index({ hospitalId: 1, scheduledDate: 1, status: 1 });

module.exports = mongoose.model('OTSchedule', otScheduleSchema);