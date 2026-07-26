const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    subscriptionRequestId: { type: String, required: true, index: true },
    subscriptionId: { type: String, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    status: {
      type: String,
      enum: ['REQUESTED', 'GRANTED', 'DENIED', 'REVOKED', 'EXPIRED', 'FAILED'],
      default: 'REQUESTED',
      index: true
    },
    hiTypes: [String],
    categories: [String],
    period: { from: Date, to: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: mongoose.Schema.Types.Mixed,
    error: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, subscriptionRequestId: 1 }, { unique: true });

module.exports = mongoose.model('AbdmSubscription', schema);
