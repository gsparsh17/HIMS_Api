const mongoose = require('mongoose');

const otScheduleSchema = new mongoose.Schema({
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
  duration_minutes: { type: Number, default: 60 },
  status: {
    type: String,
    enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled', 'Rescheduled'],
    default: 'Scheduled'
  },
  notes: String
}, { timestamps: true });

otScheduleSchema.index({ otRoomId: 1, scheduledDate: 1 });
otScheduleSchema.index({ requestId: 1 });
otScheduleSchema.index({ scheduledDate: 1, status: 1 });

module.exports = mongoose.model('OTSchedule', otScheduleSchema);