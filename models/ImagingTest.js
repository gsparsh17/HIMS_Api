const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const STANDARD_IMAGING_CATEGORIES = [
  'X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'ECG', 'Echocardiography',
  'EEG', 'EMG', 'NCV', 'TMT', 'Mammography', 'PET Scan', 'DEXA Scan',
  'Fluoroscopy', 'Angiography', 'Interventional Radiology', 'Nuclear Medicine', 'Other'
];

function normalizeImagingCategory(val) {
  if (!val) return 'Other';
  const trimmed = String(val).trim();
  if (!trimmed) return 'Other';
  const lower = trimmed.toLowerCase();
  let matched = STANDARD_IMAGING_CATEGORIES.find((c) => c.toLowerCase() === lower);
  if (!matched) {
    if (lower === 'xray') matched = 'X-Ray';
    else if (lower === 'ct') matched = 'CT Scan';
    else if (lower === 'usg' || lower === 'sonography') matched = 'Ultrasound';
    else if (lower === 'echo') matched = 'Echocardiography';
    else if (lower === 'pet') matched = 'PET Scan';
    else if (lower === 'dexa') matched = 'DEXA Scan';
  }
  return matched || trimmed;
}

function normalizeInsuranceCoverage(val) {
  if (!val) return 'Partial';
  const s = String(val).trim().toLowerCase();
  if (s === 'none' || s === 'no') return 'None';
  if (s === 'full' || s === 'yes') return 'Full';
  if (s.includes('pre-auth') || s.includes('preauthorization') || s.includes('pre-authorization')) return 'Pre-authorization Required';
  return 'Partial';
}

const imagingTestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, uppercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  aliases: [{ type: String, trim: true }],
  report_template_id: { type: String, trim: true, index: true },
  report_template_name: { type: String, trim: true },
  report_template_version: { type: String, trim: true },
  category: {
    type: String,
    trim: true,
    default: 'Other',
    set: normalizeImagingCategory,
    index: true
  },
  description: { type: String, trim: true },
  preparation_instructions: { type: String, trim: true },
  contraindications: { type: String, trim: true },
  contrast_required: { type: Boolean, default: false },
  contrast_details: { type: String, trim: true },
  turnaround_time_hours: { type: Number, default: 24, min: 0 },
  base_price: { type: Number, default: 0, min: 0 },
  priceHistory: [{ amount: { type: Number, min: 0 }, effectiveFrom: Date, effectiveTo: Date, reason: String, changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }],
  insurance_coverage: {
    type: String,
    default: 'Partial',
    set: normalizeInsuranceCoverage
  },
  // Report templates and billable orderable services are separate concepts.
  template_only: { type: Boolean, default: false, index: true },
  is_billable: { type: Boolean, default: true, index: true },
  allow_zero_price: { type: Boolean, default: false },
  canonical_test_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ImagingTest', index: true },
  is_active: { type: Boolean, default: true, index: true },
  usage_count: { type: Number, default: 0 },
  last_used: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

imagingTestSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
imagingTestSchema.index({ hospitalId: 1, name: 1 });
imagingTestSchema.index({ hospitalId: 1, category: 1, is_active: 1, is_billable: 1, template_only: 1 });

imagingTestSchema.pre('validate', function validateImaging(next) {
  this.category = normalizeImagingCategory(this.category);
  this.insurance_coverage = normalizeInsuranceCoverage(this.insurance_coverage);

  if (this.template_only) this.is_billable = false;
  if (this.is_active && this.is_billable && Number(this.base_price || 0) === 0 && !this.allow_zero_price) {
    this.invalidate('base_price', 'Active billable imaging tests require a positive cash price or allow_zero_price=true');
  }
  next();
});

imagingTestSchema.methods.incrementUsage = function incrementUsage() {
  this.usage_count = Number(this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

addSoftDeleteFields(imagingTestSchema);

module.exports = mongoose.model('ImagingTest', imagingTestSchema);
module.exports.STANDARD_IMAGING_CATEGORIES = STANDARD_IMAGING_CATEGORIES;
