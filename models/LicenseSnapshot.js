const mongoose = require('mongoose');
const { mergeEntitlements, normalizeEntitlements } = require('../utils/entitlements');

const licenseSnapshotSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, unique: true, index: true },
  tenantCode: { type: String, required: true, uppercase: true, trim: true, index: true },
  masterLicenseId: { type: String, required: true, index: true },
  key: String,
  status: { type: String, enum: ['active', 'blocked', 'expired'], required: true, index: true },
  planCode: { type: String, required: true, uppercase: true, trim: true },
  planVersion: { type: Number, default: 1 },
  startsAt: Date,
  expiresAt: Date,
  entitlementSnapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  entitlementOverrides: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  effectiveEntitlements: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  limits: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  licenseVersion: { type: Number, default: 1, min: 1 },
  checkedAt: { type: Date, default: Date.now },
  nextCheckAt: Date,
  offlineGraceUntil: Date,
  lastSyncStatus: { type: String, enum: ['PROVISIONED', 'PUSHED', 'PULLED', 'FAILED', 'MIGRATED'], default: 'PROVISIONED' },
  lastSyncError: String,
  sourceUpdatedAt: Date
}, { timestamps: true });

licenseSnapshotSchema.pre('validate', function normalizeSnapshot(next) {
  this.entitlementSnapshot = normalizeEntitlements(this.entitlementSnapshot || {});
  this.effectiveEntitlements = mergeEntitlements(this.entitlementSnapshot, this.entitlementOverrides || {});
  const refreshMs = Number(process.env.LICENSE_REFRESH_INTERVAL_MS || 24 * 60 * 60 * 1000);
  const graceMs = Number(process.env.LICENSE_MAX_OFFLINE_AGE_MS || 7 * 24 * 60 * 60 * 1000);
  if (!this.checkedAt) this.checkedAt = new Date();
  this.nextCheckAt = new Date(this.checkedAt.getTime() + refreshMs);
  this.offlineGraceUntil = new Date(this.checkedAt.getTime() + graceMs);
  next();
});

module.exports = mongoose.model('LicenseSnapshot', licenseSnapshotSchema);
