const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    direction: { type: String, enum: ['OUTBOUND_HIP', 'INBOUND_HIU'], required: true, index: true },
    transactionId: { type: String, required: true, index: true },
    consentId: { type: String, required: true, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    hiTypes: [String],
    careContextReferences: [String],
    status: {
      type: String,
      enum: [
        'PREPARING',
        'VALIDATED',
        'ENCRYPTED',
        'PUSHING',
        'TRANSFERRED',
        'RECEIVED',
        'DECRYPTED',
        'IMPORTED',
        'FAILED'
      ],
      default: 'PREPARING',
      index: true
    },
    recordCount: Number,
    payloadHash: String,
    destinationHost: String,
    acknowledgement: mongoose.Schema.Types.Mixed,
    attempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, required: true, index: true },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    error: mongoose.Schema.Types.Mixed,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ hospitalId: 1, direction: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmDataTransfer', schema);
