const mongoose = require('mongoose');

const abdmWebhookEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, required: true, index: true },
    facilityId: { type: String, index: true },
    requestId: { type: String, index: true },
    transactionId: { type: String, index: true },
    payloadHash: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, select: false },
    headers: mongoose.Schema.Types.Mixed,
    processingStatus: {
      type: String,
      enum: ['RECEIVED', 'ROUTED', 'COMPLETED', 'FAILED', 'QUARANTINED'],
      default: 'RECEIVED',
      index: true
    },
    attempts: { type: Number, default: 0 },
    lastError: mongoose.Schema.Types.Mixed,
    processedAt: Date
  },
  { timestamps: true }
);

abdmWebhookEventSchema.index({ eventType: 1, requestId: 1, payloadHash: 1 }, { unique: true });

module.exports = mongoose.model('AbdmWebhookEvent', abdmWebhookEventSchema);
