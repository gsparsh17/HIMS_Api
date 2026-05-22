const mongoose = require('mongoose');

const activationSchema = new mongoose.Schema({
  deviceId: String,
  hospitalName: String,
  activatedAt: { type: Date, default: Date.now },
  lastSeen: Date,
});

const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true, trim: true },
  plan: { type: String, default: 'basic', trim: true },

  maxActivations: { type: Number, default: 2, min: 1 },
  activations: [activationSchema],

  status: {
    type: String,
    enum: ['active', 'blocked', 'expired'],
    default: 'active',
    index: true,
  },

  expiryDate: Date,

  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },
  issuedTo: { type: String, trim: true },
  notes: String,
  features: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: Date,

  createdAt: { type: Date, default: Date.now },
});

licenseSchema.pre('save', function setUpdatedAt(next) {
  if (!this.isNew) this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('License', licenseSchema);
