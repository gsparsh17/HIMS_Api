const mongoose = require('mongoose');

const financeFeatureFlagSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  key: {
    type: String,
    enum: [
      'financeCanonicalKpis', 'canonicalIpdChargePosting', 'ipdSelectedChargeBillNow',
      'deskModule', 'appointmentIdempotency', 'opdSettlementPreview',
      'sourceBillingStateSync', 'disableLegacyIpdDirectBilling'
    ],
    required: true
  },
  enabled: { type: Boolean, default: false },
  notes: { type: String, trim: true },
  enabledAt: Date,
  enabledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

financeFeatureFlagSchema.index({ hospitalId: 1, key: 1 }, { unique: true });
module.exports = mongoose.model('FinanceFeatureFlag', financeFeatureFlagSchema);
