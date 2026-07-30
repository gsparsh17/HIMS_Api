const mongoose = require('mongoose');

const consentStatusSchema = new mongoose.Schema(
  {
    consentIdHash: { type: String, required: true, index: true },
    artefactHash: { type: String, index: true },
    status: { type: String, required: true, index: true },
    effectiveAt: { type: Date, required: true, index: true },
    sourceEventIdHash: { type: String, required: true, unique: true, index: true },
    source: { type: String, default: 'HOSPITAL_BACKEND' },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);
consentStatusSchema.index({ consentIdHash: 1, effectiveAt: -1 });

const usageWindowSchema = new mongoose.Schema(
  {
    consentIdHash: { type: String, required: true, index: true },
    operationType: { type: String, required: true, index: true },
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },
    maxUses: { type: Number, required: true },
    used: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 }
  },
  { timestamps: true }
);
usageWindowSchema.index(
  { consentIdHash: 1, operationType: 1, windowStart: 1 },
  { unique: true }
);

const usageReservationSchema = new mongoose.Schema(
  {
    reservationId: { type: String, required: true, unique: true, index: true },
    operationHash: { type: String, required: true, unique: true, index: true },
    consentIdHash: { type: String, required: true, index: true },
    operationType: { type: String, required: true, index: true },
    windowId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConsentUsageWindow', required: true },
    status: {
      type: String,
      enum: ['RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED'],
      default: 'RESERVED',
      index: true
    },
    expiresAt: { type: Date, required: true, index: true },
    committedAt: Date,
    releasedAt: Date
  },
  { timestamps: true }
);
usageReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

const decisionSchema = new mongoose.Schema(
  {
    validationId: { type: String, required: true, unique: true, index: true },
    operationHash: { type: String, required: true, index: true },
    consentIdHash: { type: String, required: true, index: true },
    artefactHash: { type: String, required: true, index: true },
    decision: { type: String, enum: ['PERMIT', 'DENY'], required: true, index: true },
    reasonCodes: [String],
    operationType: String,
    trust: mongoose.Schema.Types.Mixed,
    reservationId: String,
    retentionUntil: Date,
    validatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true }
);
decisionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  ConsentStatusEvent:
    mongoose.models.ConsentStatusEvent ||
    mongoose.model('ConsentStatusEvent', consentStatusSchema),
  ConsentUsageWindow:
    mongoose.models.ConsentUsageWindow ||
    mongoose.model('ConsentUsageWindow', usageWindowSchema),
  ConsentUsageReservation:
    mongoose.models.ConsentUsageReservation ||
    mongoose.model('ConsentUsageReservation', usageReservationSchema),
  ConsentValidationDecision:
    mongoose.models.ConsentValidationDecision ||
    mongoose.model('ConsentValidationDecision', decisionSchema)
};
