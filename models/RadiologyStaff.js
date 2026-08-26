const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const radiologyStaffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  name: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true
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
    enum: ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Interventional Radiology', 'Nuclear Medicine', 'Fluoroscopy', 'Angiography', 'DEXA Scan', 'PET Scan']
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
radiologyStaffSchema.index({ hospitalId: 1, userId: 1 }, { unique: true, sparse: true });
radiologyStaffSchema.index({ hospitalId: 1, designation: 1 });
radiologyStaffSchema.index({ hospitalId: 1, is_active: 1, availabilityStatus: 1 });

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(radiologyStaffSchema, 'RadiologyStaff');

addSoftDeleteFields(radiologyStaffSchema);

module.exports = mongoose.model('RadiologyStaff', radiologyStaffSchema);