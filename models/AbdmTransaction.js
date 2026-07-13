const mongoose = require('mongoose');

const abdmTransactionSchema = new mongoose.Schema(
  {
    requestId: { type: String, index: true },
    transactionId: { type: String, index: true },
    facilityId: { type: String, required: true, index: true },
    flow: {
      type: String,
      required: true,
      enum: [
        'PROFILE_SHARE',
        'HIP_LINK_TOKEN',
        'HIP_CARE_CONTEXT_LINK',
        'CARE_CONTEXT_UPDATE',
        'USER_DISCOVERY',
        'USER_LINK_INIT',
        'USER_LINK_CONFIRM',
        'CONSENT_NOTIFY',
        'HEALTH_INFORMATION_REQUEST',
        'HEALTH_INFORMATION_PUSH',
        'M3_CONSENT',
        'OTHER'
      ],
      index: true
    },
    direction: { type: String, enum: ['INBOUND', 'OUTBOUND'], required: true },
    status: {
      type: String,
      enum: ['RECEIVED', 'ACCEPTED', 'PROCESSING', 'WAITING_CALLBACK', 'COMPLETED', 'FAILED', 'EXPIRED'],
      default: 'RECEIVED',
      index: true
    },
    correlation: mongoose.Schema.Types.Mixed,
    error: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, index: true }
  },
  { timestamps: true }
);

abdmTransactionSchema.index({ requestId: 1, facilityId: 1 });
abdmTransactionSchema.index({ transactionId: 1, facilityId: 1 });
abdmTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

module.exports = mongoose.model('AbdmTransaction', abdmTransactionSchema);
