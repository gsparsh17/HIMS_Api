const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  evidenceId: { type: String, required: true, unique: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  mode: { type: String, enum: ['HIP_INITIATED', 'USER_INITIATED'], required: true },
  selectedCareContextIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AbdmCareContext' }],
  selectedReferenceNumbers: [{ type: String }],
  selectedContextsHash: { type: String, required: true },
  linkTokenRequestId: { type: String, index: true },
  linkTokenCallbackRequestId: { type: String, index: true },
  careContextLinkRequestId: { type: String, index: true },
  transactionId: { type: String, index: true },
  authentication: {
    authenticationType: String,
    communicationMedium: String,
    communicationHint: String,
    communicationExpiry: Date
  },
  status: {
    type: String,
    enum: ['CREATED', 'TOKEN_REQUESTED', 'TOKEN_RECEIVED', 'LINK_REQUESTED', 'CONFIRMED', 'FAILED', 'CONTEXT_CHANGED'],
    default: 'CREATED',
    index: true
  },
  failure: mongoose.Schema.Types.Mixed,
  confirmedAt: Date
}, { timestamps: true });

schema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });
module.exports = mongoose.model('AbdmLinkAuthorizationEvidence', schema);
