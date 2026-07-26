const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['PROCESS_HIP_DATA_REQUEST', 'PROCESS_HIU_DATA_PUSH'],
      index: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD'],
      default: 'PENDING',
      index: true
    },
    idempotencyKey: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, select: false },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    runAfter: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    completedAt: Date,
    lastError: mongoose.Schema.Types.Mixed,
    purgeAt: Date
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ hospitalId: 1, status: 1, runAfter: 1, createdAt: 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AbdmHospitalJob', schema);
