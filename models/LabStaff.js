const mongoose = require('mongoose');

const labStaffSchema = new mongoose.Schema({
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
    enum: ['Pathologist', 'Lab Technician', 'Lab Assistant', 'Phlebotomist', 'Lab Manager', 'Quality Controller'],
    required: true
  },
  specialization: {
    type: String,
    trim: true
  },
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

module.exports = mongoose.model('LabStaff', labStaffSchema);