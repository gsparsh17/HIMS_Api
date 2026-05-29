const mongoose = require('mongoose');

const staffAvailabilitySchema = new mongoose.Schema({
  employee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'HRStaffProfile', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['available', 'busy', 'on_leave', 'off_duty', 'in_ot', 'in_ward', 'in_opd', 'emergency', 'unavailable'],
    default: 'available'
  },
  current_location: { type: String, trim: true },
  valid_from: { type: Date, default: Date.now },
  valid_to: { type: Date },
  note: { type: String, trim: true },
  hospital_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

staffAvailabilitySchema.index({ employee_id: 1, createdAt: -1 });
staffAvailabilitySchema.index({ hospital_id: 1, status: 1 });
staffAvailabilitySchema.index({ user_id: 1 });

module.exports = mongoose.model('StaffAvailability', staffAvailabilitySchema);
