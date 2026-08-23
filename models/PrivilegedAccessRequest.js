const mongoose = require('mongoose');
const { PRIVILEGED_ACTIONS, DUAL_CONTROL_ACTIONS } = require('../utils/privilegedActions');

const REQUESTABLE_ACTIONS = Array.from(new Set([...PRIVILEGED_ACTIONS, ...DUAL_CONTROL_ACTIONS]));

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, enum: REQUESTABLE_ACTIONS, required: true, index: true },
  actionType: { type: String, enum: ['PRIVILEGED_ACTION', 'SENSITIVE_ACTION'], default: 'PRIVILEGED_ACTION' },
  operation: { type: String, enum: ['GRANT', 'REVOKE'], default: 'GRANT' },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING', index: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  decisionReason: { type: String, trim: true, maxlength: 1000 },
  decidedAt: Date,
  expiresAt: Date,
  metadata: mongoose.Schema.Types.Mixed
}, { timestamps: true });

schema.index({ hospitalId: 1, status: 1, createdAt: -1 });
schema.index({ targetUserId: 1, action: 1, status: 1 });
module.exports = mongoose.model('PrivilegedAccessRequest', schema);
