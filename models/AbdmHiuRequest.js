const mongoose = require('mongoose');

const encryptedBlobSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, required: true, select: false },
    iv: { type: String, required: true, select: false },
    tag: { type: String, required: true, select: false },
    keyVersion: { type: String, default: 'v1' }
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    requestId: { type: String, required: true, index: true },
    masterRequestId: { type: String, index: true },
    transactionId: { type: String, index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    consentId: { type: String, required: true, index: true },
    consentRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmHospitalConsent', index: true },
    status: {
      type: String,
      enum: [
        'DRAFT',
        'REQUESTED',
        'ACKNOWLEDGED',
        'DATA_RECEIVED',
        'DECRYPTING',
        'IMPORTED',
        'FAILED',
        'EXPIRED'
      ],
      default: 'DRAFT',
      index: true
    },
    hiTypes: [String],
    dateRange: { from: Date, to: Date },
    relayId: String,
    dataPushUrlHash: String,
    keyMaterial: mongoose.Schema.Types.Mixed,
    encryptedPrivateMaterial: { type: encryptedBlobSchema, select: false },
    keyExpiresAt: Date,
    receivedEntryCount: { type: Number, default: 0 },
    importedRecordCount: { type: Number, default: 0 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedAt: Date,
    acknowledgedAt: Date,
    dataReceivedAt: Date,
    completedAt: Date,
    error: mongoose.Schema.Types.Mixed,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, requestId: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });
schema.index({ hospitalId: 1, consentId: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmHiuRequest', schema);
