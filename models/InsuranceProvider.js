// models/InsuranceProvider.js
const mongoose = require('mongoose');

const insuranceProviderSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  type: {
    type: String,
    enum: ['public', 'private', 'tpa', 'government'],
    default: 'private'
  },
  category: {
    type: String,
    enum: ['health_insurance', 'motor_insurance', 'life_insurance', 'corporate', 'government_scheme'],
    default: 'health_insurance'
  },
  contact_person: {
    type: String,
    trim: true
  },
  contact_phone: {
    type: String,
    trim: true
  },
  contact_email: {
    type: String,
    lowercase: true,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  is_active: {
    type: Boolean,
    default: true
  },
  is_approved: {
    type: Boolean,
    default: true
  },
  approval_date: {
    type: Date,
    default: Date.now
  },
  approved_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  empanelment_date: {
    type: Date
  },
  empanelment_number: {
    type: String,
    trim: true
  },
  coverage_percentage: {
    type: Number,
    default: 100,
    min: 0,
    max: 100
  },
  notes: {
    type: String,
    trim: true
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Indexes
insuranceProviderSchema.index({ name: 1, code: 1 });
insuranceProviderSchema.index({ is_active: 1, is_approved: 1 });
insuranceProviderSchema.index({ type: 1, category: 1 });

module.exports = mongoose.model('InsuranceProvider', insuranceProviderSchema);