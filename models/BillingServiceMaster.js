const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  chargeCode: { type: String, required: true, trim: true, uppercase: true },
  chargeName: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  departmentName: String,
  serviceType: { type: String, required: true, trim: true },
  unit: { type: String, default: 'Each', trim: true },
  price: { type: Number, required: true, min: 0 },
  taxRate: { type: Number, default: 0, min: 0, max: 100 },
  active: { type: Boolean, default: true },
  effectiveFrom: { type: Date, default: Date.now },
  effectiveTo: Date,
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, chargeCode: 1, effectiveFrom: 1 }, { unique: true });

module.exports = mongoose.model('BillingServiceMaster', schema);