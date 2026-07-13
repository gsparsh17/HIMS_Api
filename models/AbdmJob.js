const mongoose = require('mongoose');

const abdmJobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    facilityId: { type: String, index: true },
    status: { type: String, enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD'], default: 'PENDING', index: true },
    payload: mongoose.Schema.Types.Mixed,
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAfter: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lastError: mongoose.Schema.Types.Mixed,
    purgeAt: Date
  },
  { timestamps: true }
);

abdmJobSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
abdmJobSchema.index({ status: 1, runAfter: 1, createdAt: 1 });

module.exports = mongoose.model('AbdmJob', abdmJobSchema);
