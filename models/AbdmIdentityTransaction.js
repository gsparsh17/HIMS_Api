const mongoose = require('mongoose');

const consentEvidenceSchema = new mongoose.Schema(
  {
    code: String,
    version: String,
    textHash: String,
    acceptedAt: Date,
    acceptedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient' },
    sourceIp: String,
    userAgent: String
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    txnId: { type: String, required: true, unique: true, index: true },
    flow: {
      type: String,
      required: true,
      enum: [
        'AADHAAR_ENROLMENT',
        'EXISTING_ABHA_SEARCH',
        'EXISTING_ABHA_LOGIN',
        'MOBILE_VERIFICATION',
        'ABHA_ADDRESS_CREATION',
        'PROFILE_UPDATE',
        'DOCUMENT_ENROLMENT',
        'BIOMETRIC_ENROLMENT',
        'GENERIC_ABHA_LOGIN',
        'PASSWORD_LOGIN',
        'ABHA_ADDRESS_LOGIN',
        'FACE_LOGIN',
        'FINGERPRINT_LOGIN',
        'IRIS_LOGIN'
      ],
      index: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: [
        'OTP_REQUESTED',
        'OTP_VERIFIED',
        'PROFILE_FETCHED',
        'COMPLETED',
        'FAILED',
        'EXPIRED',
        'LOCKED'
      ],
      default: 'OTP_REQUESTED',
      index: true
    },
    selectedIndex: String,
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastOtpSentAt: Date,
    lastAttemptAt: Date,
    completedAt: Date,
    expiresAt: { type: Date, required: true },
    consent: consentEvidenceSchema,
    requestContext: {
      requestId: String,
      sourceIpHash: String,
      userAgentHash: String
    },
    metadata: mongoose.Schema.Types.Mixed,
    error: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, patientId: 1, flow: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('AbdmIdentityTransaction', schema);
