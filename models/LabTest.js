const mongoose = require('mongoose');

// Master catalog of Lab Tests
// Mirrors models/Procedure.js structure so UI/logic can behave similarly.

const labTestSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  category: {
    type: String,
    enum: [
      'Hematology',
      'Biochemistry',
      'Microbiology',
      'Immunology',
      'Pathology',
      'Radiology',
      'Endocrinology',
      'Cardiology',
      'Other'
    ],
    default: 'Other',
    index: true
  },
  description: {
    type: String,
    trim: true
  },

  // Common lab-test metadata
  specimen_type: {
    type: String,
    trim: true
  },
  fasting_required: {
    type: Boolean,
    default: false
  },
  turnaround_time_hours: {
    type: Number,
    default: 24,
    min: 0
  },

  // Pricing
  base_price: {
    type: Number,
    default: 0,
    min: 0
  },
  insurance_coverage: {
    type: String,
    enum: ['None', 'Partial', 'Full'],
    default: 'Partial'
  },

  // Admin
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  usage_count: {
    type: Number,
    default: 0
  },
  last_used: {
    type: Date
  }
}, {
  timestamps: true
});

// Helpful search index
labTestSchema.index({ code: 1, name: 1, category: 1 });

labTestSchema.methods.incrementUsage = async function () {
  this.usage_count = (this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

module.exports = mongoose.model('LabTest', labTestSchema);
