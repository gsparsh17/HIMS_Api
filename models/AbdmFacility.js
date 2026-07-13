const mongoose = require('mongoose');
const { ONBOARDING_STATES, TEST_STATUSES } = require('../utils/abdmOnboarding');

const encryptedSecretSchema = new mongoose.Schema(
  {
    ciphertext: { type: String, select: false },
    iv: { type: String, select: false },
    tag: { type: String, select: false }
  },
  { _id: false }
);

const verificationActorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: String,
    email: String
  },
  { _id: false }
);

const rolloutTestSchema = new mongoose.Schema(
  {
    status: { type: String, enum: TEST_STATUSES, default: 'NOT_TESTED' },
    lastTestedAt: Date,
    testedBy: verificationActorSchema,
    evidence: String,
    notes: String
  },
  { _id: false }
);

const abdmFacilitySchema = new mongoose.Schema(
  {
    hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true, sparse: true },
    tenantCode: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true },

    hfr: {
      facilityId: { type: String, trim: true, index: true, sparse: true },
      facilityName: { type: String, trim: true },
      status: {
        type: String,
        enum: ['UNKNOWN', 'RECEIVED', 'PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED'],
        default: 'UNKNOWN',
        index: true
      },
      verifiedAt: Date,
      verificationSource: String,
      evidenceReference: String,
      verifiedBy: verificationActorSchema
    },

    abdm: {
      bridgeId: { type: String, trim: true, index: true },
      hipId: { type: String, trim: true, index: true, sparse: true },
      hipName: { type: String, trim: true },
      serviceType: { type: String, trim: true },
      active: { type: Boolean, default: false },
      linkageStatus: {
        type: String,
        enum: ['NOT_STARTED', 'PENDING', 'LINKED', 'FAILED'],
        default: 'NOT_STARTED',
        index: true
      },
      linkageCheckedAt: Date,
      linkageVerifiedAt: Date,
      linkageVerifiedBy: verificationActorSchema,
      verificationResponse: mongoose.Schema.Types.Mixed,
      environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox', index: true }
    },

    connector: {
      baseUrl: { type: String, trim: true },
      keyId: { type: String, trim: true },
      secretEncrypted: { type: encryptedSecretSchema, select: false },
      status: {
        type: String,
        enum: ['NOT_CONFIGURED', 'PENDING', 'ACTIVE', 'DISABLED', 'UNREACHABLE'],
        default: 'NOT_CONFIGURED',
        index: true
      },
      lastHealthCheckAt: Date,
      lastHealthCheckStatus: String,
      lastHealthCheckResponse: mongoose.Schema.Types.Mixed
    },

    onboardingStatus: {
      type: String,
      enum: ONBOARDING_STATES,
      default: 'NOT_CONFIGURED',
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
          category: String,
          active: { type: Boolean, default: true }
        }
      ]
    },

    rollout: {
      scanAndShare: { type: rolloutTestSchema, default: () => ({}) },
      careContext: { type: rolloutTestSchema, default: () => ({}) },
      dataExchange: { type: rolloutTestSchema, default: () => ({}) }
    },

    goLive: {
      activatedAt: Date,
      activatedBy: verificationActorSchema,
      notes: String
    },

    active: { type: Boolean, default: true, index: true },
    metadata: mongoose.Schema.Types.Mixed,

    // Deprecated compatibility fields. Existing callback/routing code may still read these
    // while the migration script moves old records to the nested HFR/ABDM structure.
    facilityId: { type: String, trim: true, index: true, sparse: true },
    facilityName: { type: String, trim: true },
    bridgeId: { type: String, trim: true },
    environment: { type: String, enum: ['sandbox', 'production'] },
    hfrStatus: String,
    softwareLinkageStatus: String
  },
  { timestamps: true }
);

abdmFacilitySchema.pre('validate', function syncCompatibility(next) {
  this.hfr = this.hfr || {};
  this.abdm = this.abdm || {};

  if (!this.hfr.facilityId && this.metadata?.hfrFacilityId) this.hfr.facilityId = this.metadata.hfrFacilityId;
  if (!this.hfr.facilityId && this.facilityId) this.hfr.facilityId = this.facilityId;
  if (!this.hfr.facilityName && this.facilityName) this.hfr.facilityName = this.facilityName;
  if (!this.abdm.hipId && this.facilityId) this.abdm.hipId = this.facilityId;
  if (!this.abdm.bridgeId && this.bridgeId) this.abdm.bridgeId = this.bridgeId;
  if (!this.abdm.environment && this.environment) this.abdm.environment = this.environment;
  if (this.hfrStatus && (!this.hfr.status || this.hfr.status === 'UNKNOWN')) this.hfr.status = this.hfrStatus;
  if (this.softwareLinkageStatus && this.abdm.linkageStatus === 'NOT_STARTED') {
    this.abdm.linkageStatus = this.softwareLinkageStatus;
  }

  this.facilityId = this.abdm.hipId || this.facilityId;
  this.facilityName = this.hfr.facilityName || this.abdm.hipName || this.facilityName;
  this.bridgeId = this.abdm.bridgeId || this.bridgeId;
  this.environment = this.abdm.environment || this.environment;
  this.hfrStatus = this.hfr.status;
  this.softwareLinkageStatus = this.abdm.linkageStatus;

  next();
});

abdmFacilitySchema.index({ 'abdm.hipId': 1 }, { unique: true, sparse: true });
abdmFacilitySchema.index({ 'hfr.facilityId': 1, 'abdm.bridgeId': 1 }, { unique: true, sparse: true });
abdmFacilitySchema.index({ hospital: 1 }, { unique: true, sparse: true });
abdmFacilitySchema.index({ facilityId: 1, active: 1 });

module.exports = mongoose.model('AbdmFacility', abdmFacilitySchema);
