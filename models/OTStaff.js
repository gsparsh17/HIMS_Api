const mongoose = require('mongoose');

const otStaffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
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
    enum: [
      'OT Manager', 
      'OT Technician', 
      'Scrub Nurse', 
      'Circulating Nurse', 
      'Anesthesia Assistant',
      'OT Staff',           // Added
      'OT Nurse',           // Added
      'Surgical Assistant', // Added
      'Sterilization Technician' // Added
    ],
    required: true
  },
  specializations: [{
    type: String,
    enum: [
      'General Surgery',
      'Cardiothoracic Surgery',
      'Neuro Surgery',
      'Orthopedic Surgery',
      'Pediatric Surgery',
      'Plastic Surgery',
      'Urology',
      'Gynecology',
      'Ophthalmology',
      'ENT',
      'Anesthesia',
      'OT Technician',
      'Scrub Nurse',
      'Circulating Nurse'
    ]
  }],
  qualification: String,
  experience_years: { type: Number, default: 0 },
  license_number: String,
  is_active: { type: Boolean, default: true },
  joined_date: { type: Date, default: Date.now },
  credential_valid_until: Date,
  shiftAvailability: [{ dayOfWeek: Number, startTime: String, endTime: String }],
  unavailableRanges: [{ from: Date, to: Date, reason: String }],
  maxSimultaneousCases: { type: Number, default: 1, min: 1 }
}, { timestamps: true });

otStaffSchema.index({ hospitalId: 1, employeeId: 1 }, { unique: true });
otStaffSchema.index({ hospitalId: 1, designation: 1, is_active: 1 });
otStaffSchema.index({ is_active: 1 });

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(otStaffSchema, 'OTStaff');

module.exports = mongoose.model('OTStaff', otStaffSchema);