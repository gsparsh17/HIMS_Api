const mongoose = require('mongoose');

const { addSoftDeleteFields } = require('../utils/softDelete');
const labParameterSchema = new mongoose.Schema({
  code: { type: String, trim: true },
  name: { type: String, required: true, trim: true },
  resultType: { type: String, enum: ['numeric', 'text', 'boolean'], default: 'text' },
  unit: { type: String, trim: true },
  referenceText: { type: String, trim: true },
  referenceLow: { type: String, trim: true },
  referenceHigh: { type: String, trim: true },
  criticalLow: { type: String, trim: true },
  criticalHigh: { type: String, trim: true },
  sex: { type: String, enum: ['any', 'male', 'female', 'other'], default: 'any' },
  minAgeYears: Number,
  maxAgeYears: Number,
  sortOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true }
}, { _id: false });

const BROAD_SPECIMEN_TYPES = ['Blood', 'Urine', 'Stool', 'CSF', 'Sputum', 'Tissue', 'Swab', 'Body Fluid', 'Semen', 'Other', 'Not Applicable'];

const labTestSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  code: { type: String, required: true, uppercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  category: {
    type: String,
    enum: ['Hematology', 'Biochemistry', 'Microbiology', 'Immunology', 'Pathology', 'Serology', 'Toxicology', 'Endocrinology', 'Molecular Diagnostics', 'Genetic Testing', 'Other'],
    default: 'Other',
    index: true
  },
  subCategory: { type: String, trim: true },
  main_service: { type: String, trim: true, index: true },
  parameters: [labParameterSchema],
  masterSource: {
    key: { type: String, trim: true },
    version: { type: String, trim: true },
    serialNumber: Number,
    checksum: String,
    importedAt: Date
  },
  description: { type: String, trim: true },
  aliases: [{ type: String, trim: true }],
  service_domain: { type: String, enum: ['laboratory'], default: 'laboratory', immutable: true },
  report_template_id: { type: String, trim: true, index: true },
  report_template_name: { type: String, trim: true },
  report_template_version: { type: String, trim: true },
  specimen_type: { type: String, enum: BROAD_SPECIMEN_TYPES, default: 'Blood' },
  // Detailed source wording such as "EDTA whole blood" or "Plasma (citrate)".
  specimen_detail: { type: String, trim: true },
  specimen_volume: { type: String, trim: true },
  container_type: { type: String, trim: true },
  fasting_required: { type: Boolean, default: false },
  fasting_hours: { type: Number, default: 0, min: 0 },
  preparation_instructions: { type: String, trim: true },
  turnaround_time_hours: { type: Number, default: 24, min: 0 },
  normal_range: { type: String, trim: true },
  critical_low: { type: String, trim: true },
  critical_high: { type: String, trim: true },
  units: { type: String, trim: true },
  base_price: { type: Number, default: 0, min: 0 },
  priceHistory: [{ amount: { type: Number, min: 0 }, effectiveFrom: Date, effectiveTo: Date, reason: String, changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }],
  insurance_coverage: { type: String, enum: ['None', 'Partial', 'Full'], default: 'Partial' },
  is_billable: { type: Boolean, default: true, index: true },
  allow_zero_price: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true, index: true },
  is_credited: { type: Boolean, default: false },
  usage_count: { type: Number, default: 0 },
  last_used: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

labTestSchema.index({ hospitalId: 1, code: 1 }, { unique: true });
labTestSchema.index({ hospitalId: 1, name: 1 });
labTestSchema.index({ hospitalId: 1, category: 1, is_active: 1, is_billable: 1 });

labTestSchema.pre('validate', function validateLab(next) {
  if (this.is_active && this.is_billable && Number(this.base_price || 0) === 0 && !this.allow_zero_price) {
    this.invalidate('base_price', 'Active billable lab tests require a positive cash price or allow_zero_price=true');
  }
  next();
});

labTestSchema.methods.incrementUsage = function incrementUsage() {
  this.usage_count = Number(this.usage_count || 0) + 1;
  this.last_used = new Date();
  return this.save();
};

addSoftDeleteFields(labTestSchema);

module.exports = mongoose.model('LabTest', labTestSchema);
module.exports.BROAD_SPECIMEN_TYPES = BROAD_SPECIMEN_TYPES;
