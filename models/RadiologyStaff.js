const mongoose = require('mongoose');

const radiologyStaffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  employeeId: {
    type: String,
    required: true
  },
  designation: {
    type: String,
    enum: ['Radiologist', 'Radiology Technician', 'Sonographer', 'MRI Technician', 'CT Technician', 'X-Ray Technician', 'Administrator'],
    required: true
  },
  specializations: [{
    type: String,
    enum: ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Interventional Radiology', 'Nuclear Medicine']
  }],
  qualification: {
    type: String,
    trim: true
  },
  experience_years: {
    type: Number,
    default: 0
  },
  license_number: {
    type: String,
    trim: true
  },
  is_active: {
    type: Boolean,
    default: true
  },
  modalityAssignments: [{ type: String, trim: true }],
  availabilityStatus: { type: String, enum: ['Available', 'Busy', 'Unavailable', 'On Leave'], default: 'Available', index: true },
  joined_date: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
radiologyStaffSchema.index({ hospitalId: 1, employeeId: 1 }, { unique: true });
radiologyStaffSchema.index({ hospitalId: 1, userId: 1 }, { unique: true });
radiologyStaffSchema.index({ hospitalId: 1, designation: 1 });
radiologyStaffSchema.index({ hospitalId: 1, is_active: 1, availabilityStatus: 1 });

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(radiologyStaffSchema, 'RadiologyStaff');

module.exports = mongoose.model('RadiologyStaff', radiologyStaffSchema);