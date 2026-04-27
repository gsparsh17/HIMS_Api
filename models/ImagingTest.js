const mongoose = require('mongoose');

const imagingTestSchema = new mongoose.Schema({
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
      'X-Ray',
      'CT Scan',
      'MRI',
      'Ultrasound',
      'ECG',
      'Echocardiography',
      'Mammography',
      'PET Scan',
      'DEXA Scan',
      'Fluoroscopy',
      'Angiography',
      'Other'
    ],
    default: 'Other',
    index: true
  },
  description: {
    type: String,
    trim: true
  },
  preparation_instructions: {
    type: String,
    trim: true
  },
  contraindications: {
    type: String,
    trim: true
  },
  contrast_required: {
    type: Boolean,
    default: false
  },
  contrast_details: {
    type: String,
    trim: true
  },
  turnaround_time_hours: {
    type: Number,
    default: 24,
    min: 0
  },
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
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes for search
imagingTestSchema.index({ code: 1, name: 1, category: 1 });

imagingTestSchema.methods.incrementUsage = async function () {
  this.usage_count = (this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

module.exports = mongoose.model('ImagingTest', imagingTestSchema);