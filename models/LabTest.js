const mongoose = require('mongoose');

const labTestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: {
    type: String,
    required: true,
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
      'Serology',
      'Toxicology',
      'Endocrinology',
      'Cardiology',
      'Molecular Diagnostics',
      'Genetic Testing',
      'Other'
    ],
    default: 'Other',
    index: true
  },
  subCategory: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },

  // Optional link to one of the 105 structured report templates.
  report_template_id: {
    type: String,
    trim: true,
    index: true
  },
  report_template_name: {
    type: String,
    trim: true
  },
  report_template_version: {
    type: String,
    trim: true
  },
  
  // Specimen requirements
  specimen_type: {
    type: String,
    enum: ['Blood', 'Urine', 'Stool', 'CSF', 'Sputum', 'Tissue', 'Swab', 'Other'],
    default: 'Blood'
  },
  specimen_volume: {
    type: String,
    trim: true
  },
  container_type: {
    type: String,
    trim: true
  },
  fasting_required: {
    type: Boolean,
    default: false
  },
  fasting_hours: {
    type: Number,
    default: 0
  },
  preparation_instructions: {
    type: String,
    trim: true
  },
  
  // Turnaround
  turnaround_time_hours: {
    type: Number,
    default: 24,
    min: 0
  },
  normal_range: {
    type: String,
    trim: true
  },
  critical_low: {
    type: String,
    trim: true
  },
  critical_high: {
    type: String,
    trim: true
  },
  units: {
    type: String,
    trim: true
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
  
  // Status
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  is_credited: {
    type: Boolean,
    default: false
  },
  usage_count: {
    type: Number,
    default: 0
  },
  last_used: {
    type: Date
  },
  
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Tenant-aware natural key. A migration drops the historical global code_1 index.
labTestSchema.index({ hospitalId: 1, code: 1 }, { unique: true });

// Indexes for search
labTestSchema.index({ code: 1, name: 1, category: 1 });

labTestSchema.methods.incrementUsage = async function () {
  this.usage_count = (this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

module.exports = mongoose.model('LabTest', labTestSchema);