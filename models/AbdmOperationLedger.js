const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  operationId: { type: String, required: true, unique: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  flow: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['CREATED', 'SENT', 'EXTERNAL_ACCEPTED', 'LOCAL_COMMITTED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED'],
    default: 'CREATED',
    index: true
  },
  requestId: { type: String, index: true },
  requestFingerprint: String,
  consentEvidenceHash: String,
  externalTxnId: { type: String, index: true },
  externalResponseFingerprint: String,
  externalAcceptedAt: Date,
  localCommittedAt: Date,
  completedAt: Date,
  lastAttemptAt: Date,
  attempts: { type: Number, default: 0 },
  lastError: {
    code: String,
    message: String,
    at: Date
  },
  resultRef: mongoose.Schema.Types.Mixed,
  reconciliation: {
    requiredAt: Date,
    reason: String,
    lastCheckedAt: Date,
    resolvedAt: Date,
    resolution: String,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }
}, { timestamps: true });

schema.index({ hospitalId: 1, patientId: 1, flow: 1, createdAt: -1 });
schema.index({ hospitalId: 1, status: 1, updatedAt: 1 });
module.exports = mongoose.model('AbdmOperationLedger', schema);
