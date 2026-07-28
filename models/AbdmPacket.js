const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true
    },
    careContextId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AbdmCareContext',
      required: true,
      index: true
    },
    careContextReference: { type: String, required: true, index: true },
    hiType: { type: String, required: true, index: true },
    activeVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AbdmPacketVersion',
      index: true
    },
    latestVersion: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['DRAFT', 'PREPARED', 'VALIDATED', 'APPROVED', 'SUPERSEDED', 'FAILED'],
      default: 'DRAFT',
      index: true
    },
    reviewPolicy: {
      type: String,
      enum: ['AUTO', 'PREVIEW_ONLY', 'REQUIRED_BEFORE_LINK', 'REQUIRED_BEFORE_TRANSFER', 'DUAL_APPROVAL'],
      default: 'REQUIRED_BEFORE_TRANSFER'
    },
    lastPreparedAt: Date,
    lastValidatedAt: Date,
    lastApprovedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, careContextId: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, updatedAt: -1 });

module.exports = mongoose.model('AbdmPacket', schema);
