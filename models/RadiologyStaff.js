const mongoose = require('mongoose');

const radiologyStaffSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  employeeId: {
    type: String,
    unique: true,
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
  joined_date: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
radiologyStaffSchema.index({ employeeId: 1 });
radiologyStaffSchema.index({ designation: 1 });
radiologyStaffSchema.index({ is_active: 1 });

module.exports = mongoose.model('RadiologyStaff', radiologyStaffSchema);