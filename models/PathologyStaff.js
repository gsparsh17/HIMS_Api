// models/PathologyStaff.js
const mongoose = require('mongoose');

const pathologyStaffSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  staffId: { type: String, trim: true },
  first_name: { type: String, required: true },
  last_name: { type: String },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true },
  qualification: { type: String }, // e.g., MD Pathology, DMLT, etc.
  specialization: { type: String }, // e.g., Hematology, Microbiology, etc.
  role: { 
    type: String, 
    enum: ['lab_technician', 'lab_scientist', 'pathologist', 'lab_assistant', 'lab_manager'],
    required: true 
  },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  gender: { type: String, enum: ['male', 'female', 'other'] },
  date_of_birth: { type: Date },
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'India' }
  },
  status: { type: String, enum: ['Active', 'Inactive', 'On Leave'], default: 'Active' },
  aadharNumber: { type: String },
  panNumber: { type: String },
  profile_image: { type: String },
  joined_at: { type: Date, default: Date.now },
  
  // Lab tests this staff member can perform
  assigned_lab_tests: [{
    lab_test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LabTest' },
    lab_test_code: String,
    lab_test_name: String,
    category: String,
    can_perform: { type: Boolean, default: true },
    assigned_at: { type: Date, default: Date.now }
  }],
  accessible_test_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LabTest' }],
  
  tests_processed: { type: Number, default: 0 },
  avg_turnaround_time: { type: Number, default: 0 }, // in hours
  accuracy_rate: { type: Number, default: 0 },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: true
});

const Hospital = require('./Hospital');

function generateRandomCode(length = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

pathologyStaffSchema.pre('save', async function generateStaffId(next) {
  try {
    if (!this.hospitalId) throw new Error('hospitalId is required');
    if (!this.staffId) {
      const hospital = await Hospital.findById(this.hospitalId).select('hospitalID');
      const prefix = hospital?.hospitalID || String(this.hospitalId).slice(-6).toUpperCase();
      this.staffId = `${prefix}-LAB-${generateRandomCode(4)}`;
    }
    next();
  } catch (err) { next(err); }
});

pathologyStaffSchema.virtual('full_name').get(function() {
  return `${this.first_name} ${this.last_name || ''}`.trim();
});

pathologyStaffSchema.virtual('assigned_tests_count').get(function() {
  return this.assigned_lab_tests?.length || 0;
});

pathologyStaffSchema.virtual('active_assigned_tests_count').get(function() {
  return this.assigned_lab_tests?.filter(t => t.can_perform).length || 0;
});

// Indexes for better query performance
pathologyStaffSchema.index({ hospitalId: 1, staffId: 1 }, { unique: true });
pathologyStaffSchema.index({ hospitalId: 1, email: 1 }, { unique: true });
pathologyStaffSchema.index({ hospitalId: 1, user_id: 1 }, { unique: true, sparse: true });
pathologyStaffSchema.index({ hospitalId: 1, role: 1 });
pathologyStaffSchema.index({ hospitalId: 1, status: 1 });
pathologyStaffSchema.index({ department: 1 });
pathologyStaffSchema.index({ 'assigned_lab_tests.lab_test_id': 1 });

const { registerHRSyncHook } = require('../services/hrProfileSync.service');
registerHRSyncHook(pathologyStaffSchema, 'PathologyStaff');

module.exports = mongoose.model('PathologyStaff', pathologyStaffSchema);