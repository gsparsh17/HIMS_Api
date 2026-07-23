const mongoose = require('mongoose');

const clinicalTemplateSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    templateType: {
      type: String,
      enum: ['round', 'discharge_summary'],
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    slug: {
      type: String,
      required: true,
      trim: true
    },
    diseaseName: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    diagnosisKeywords: [{
      type: String,
      trim: true
    }],
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department'
    },
    content: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      default: {}
    },
    isSystemDefault: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    usageCount: {
      type: Number,
      default: 0,
      min: 0
    },
    lastUsedAt: Date,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

clinicalTemplateSchema.index(
  { hospitalId: 1, templateType: 1, slug: 1 },
  { unique: true }
);
clinicalTemplateSchema.index({ hospitalId: 1, templateType: 1, diseaseName: 1, isActive: 1 });

module.exports = mongoose.model('ClinicalTemplate', clinicalTemplateSchema);
