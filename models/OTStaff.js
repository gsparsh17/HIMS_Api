const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const otStaffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  // Login is optional during employee onboarding. Keep uniqueness within this
  // hospital database only when a real User ObjectId is present.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  // Deployment model is one MongoDB database per hospital, so employeeId only
  // needs to be unique inside this database (not hospitalId+employeeId).
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
      'OT Staff',
      'OT Nurse',
      'Surgical Assistant',
      'Sterilization Technician'
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

// Multiple OT staff may intentionally have no login account. A normal unique
// userId index would allow only one missing/null value. The partial unique index
// enforces one OT profile per real User while excluding no-login employees.
otStaffSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $type: 'objectId' } }
  }
);

otStaffSchema.index({ hospitalId: 1, designation: 1, is_active: 1 });
otStaffSchema.index({ is_active: 1 });

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(otStaffSchema, 'OTStaff');

addSoftDeleteFields(otStaffSchema);

module.exports = mongoose.model('OTStaff', otStaffSchema);
