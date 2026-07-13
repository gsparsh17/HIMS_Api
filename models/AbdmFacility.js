const mongoose = require('mongoose');

const encryptedSecretSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, select: false },
    iv: { type: String, select: false },
    tag: { type: String, select: false }
  },
  { _id: false }
);

const abdmFacilitySchema = new mongoose.Schema(
  {
    facilityId: { type: String, required: true, unique: true, index: true, trim: true },
    facilityName: { type: String, required: true, trim: true },
    tenantCode: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true },
    bridgeId: { type: String, required: true, trim: true },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox', index: true },
    connector: {
      baseUrl: { type: String, required: true, trim: true },
      keyId: { type: String, required: true, trim: true },
      secretEncrypted: { type: encryptedSecretSchema, select: false },
      status: { type: String, enum: ['ACTIVE', 'DISABLED', 'UNREACHABLE'], default: 'ACTIVE', index: true },
      lastHealthCheckAt: Date,
      lastHealthCheckStatus: String
    },
    hfrStatus: {
      type: String,
      enum: ['UNKNOWN', 'PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      default: 'UNKNOWN'
    },
    softwareLinkageStatus: {
      type: String,
      enum: ['NOT_STARTED', 'PENDING', 'LINKED', 'FAILED'],
      default: 'NOT_STARTED',
      index: true
    },
    services: {
      hip: { type: Boolean, default: true },
      hiu: { type: Boolean, default: false }
    },
    scanAndShare: {
      enabled: { type: Boolean, default: false },
      counters: [
        {
          counterId: String,
          name: String,
          active: { type: Boolean, default: true }
        }
      ]
    },
    active: { type: Boolean, default: true, index: true },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

abdmFacilitySchema.index({ facilityId: 1, active: 1 });

module.exports = mongoose.model('AbdmFacility', abdmFacilitySchema);
