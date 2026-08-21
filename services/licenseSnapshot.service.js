const LicenseSnapshot = require('../models/LicenseSnapshot');
const Hospital = require('../models/Hospital');
const platformConfig = require('../config/platform.config');
const { mergeEntitlements, normalizeEntitlements, isEntitled } = require('../utils/entitlements');
const { platformRequest } = require('./platformClient.service');

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
}

function warningLevel(days) {
  if (days === null) return 'none';
  if (days <= 1) return 'critical';
  if (days <= 3) return 'urgent';
  if (days <= 7) return 'warning';
  if (days <= 30) return 'notice';
  return 'none';
}

function publicLicense(snapshot) {
  if (!snapshot) return null;
  const days = daysRemaining(snapshot.expiresAt);
  return {
    status: snapshot.status,
    plan: snapshot.planCode,
    planCode: snapshot.planCode,
    planVersion: snapshot.planVersion,
    expiresAt: snapshot.expiresAt,
    daysRemaining: days,
    warningLevel: warningLevel(days),
    licenseVersion: snapshot.licenseVersion,
    checkedAt: snapshot.checkedAt,
    nextCheckAt: snapshot.nextCheckAt,
    offlineGraceUntil: snapshot.offlineGraceUntil,
    entitlements: snapshot.effectiveEntitlements || mergeEntitlements(snapshot.entitlementSnapshot, snapshot.entitlementOverrides),
    limits: snapshot.limits || {}
  };
}

async function hospitalForContext(hospitalId) {
  if (hospitalId) {
    const hospital = await Hospital.findById(hospitalId);
    if (hospital) return hospital;
  }
  if (platformConfig.tenantCode) {
    const hospital = await Hospital.findOne({ tenantCode: platformConfig.tenantCode });
    if (hospital) return hospital;
  }
  return Hospital.findOne({ is_active: { $ne: false } });
}

async function getSnapshot(hospitalId) {
  const hospital = await hospitalForContext(hospitalId);
  if (!hospital) return { hospital: null, snapshot: null };
  return { hospital, snapshot: await LicenseSnapshot.findOne({ hospitalId: hospital._id }) };
}

function applyRemotePayload(snapshot, hospital, payload, source) {
  const incomingVersion = Number(payload.licenseVersion || 1);
  if (snapshot && Number(snapshot.licenseVersion || 0) > incomingVersion) return snapshot;
  const target = snapshot || new LicenseSnapshot({ hospitalId: hospital._id, tenantCode: hospital.tenantCode || platformConfig.tenantCode });
  target.masterLicenseId = String(payload.masterLicenseId);
  target.key = payload.key;
  target.status = payload.status;
  target.planCode = payload.planCode;
  target.planVersion = Number(payload.planVersion || 1);
  target.startsAt = payload.startsAt;
  target.expiresAt = payload.expiresAt;
  target.entitlementSnapshot = normalizeEntitlements(payload.entitlementSnapshot || payload.entitlements || {});
  target.entitlementOverrides = payload.entitlementOverrides || {};
  target.effectiveEntitlements = mergeEntitlements(target.entitlementSnapshot, target.entitlementOverrides);
  target.limits = payload.limits || {};
  target.licenseVersion = incomingVersion;
  target.checkedAt = new Date();
  target.lastSyncStatus = source;
  target.lastSyncError = undefined;
  target.sourceUpdatedAt = payload.updatedAt ? new Date(payload.updatedAt) : new Date();
  return target;
}

async function upsertFromRemotePayload(payload, source = 'PUSHED') {
  const hospital = await hospitalForContext();
  if (!hospital) throw new Error('Hospital is not provisioned');
  const existing = await LicenseSnapshot.findOne({ hospitalId: hospital._id });
  const target = applyRemotePayload(existing, hospital, payload, source);
  await target.save();
  return target;
}

async function refreshLicense(options = {}) {
  const { hospital, snapshot } = await getSnapshot(options.hospitalId);
  if (!hospital) throw new Error('Hospital is not provisioned');
  try {
    const response = await platformRequest('/internal/platform/license/validate', {
      tenantCode: hospital.tenantCode || platformConfig.tenantCode,
      knownVersion: snapshot?.licenseVersion || 0
    });
    return upsertFromRemotePayload(response.license, 'PULLED');
  } catch (error) {
    if (snapshot) {
      snapshot.lastSyncStatus = 'FAILED';
      snapshot.lastSyncError = String(error.message || error).slice(0, 1000);
      await snapshot.save().catch(() => {});
    }
    throw error;
  }
}

async function activeSnapshot(hospitalId, options = {}) {
  let { snapshot } = await getSnapshot(hospitalId);
  if (!snapshot) {
    if (options.tryRefresh !== false) snapshot = await refreshLicense({ hospitalId }).catch(() => null);
    if (!snapshot) {
      const error = new Error('MediQliq license is not provisioned for this hospital');
      error.statusCode = 403;
      error.code = 'LICENSE_NOT_PROVISIONED';
      throw error;
    }
  }

  if (snapshot.expiresAt && new Date(snapshot.expiresAt).getTime() <= Date.now() && snapshot.status === 'active') {
    snapshot.status = 'expired';
    await snapshot.save().catch(() => {});
  }

  if (snapshot.status !== 'active') {
    const error = new Error(snapshot.status === 'expired' ? 'Your MediQliq subscription has expired.' : 'This MediQliq subscription is currently inactive.');
    error.statusCode = 403;
    error.code = snapshot.status === 'expired' ? 'LICENSE_EXPIRED' : 'LICENSE_BLOCKED';
    error.expiresAt = snapshot.expiresAt;
    throw error;
  }

  const nextCheck = snapshot.nextCheckAt ? new Date(snapshot.nextCheckAt).getTime() : 0;
  if (options.refreshIfDue && nextCheck && nextCheck <= Date.now()) {
    try {
      snapshot = await refreshLicense({ hospitalId });
    } catch (error) {
      const graceUntil = snapshot.offlineGraceUntil ? new Date(snapshot.offlineGraceUntil).getTime() : 0;
      if (!graceUntil || graceUntil <= Date.now()) {
        const stale = new Error('License validation is overdue and MediQliq Master could not be reached.');
        stale.statusCode = 503;
        stale.code = 'LICENSE_VALIDATION_REQUIRED';
        throw stale;
      }
    }
  }
  return snapshot;
}

async function assertEntitlement(hospitalId, key) {
  const snapshot = await activeSnapshot(hospitalId, { refreshIfDue: false });
  const entitlements = snapshot.effectiveEntitlements || mergeEntitlements(snapshot.entitlementSnapshot, snapshot.entitlementOverrides);
  if (!isEntitled(entitlements, key)) {
    const error = new Error(`The ${key.replace(/_/g, ' ')} feature is not included in this hospital's MediQliq plan.`);
    error.statusCode = 403;
    error.code = 'ENTITLEMENT_REQUIRED';
    error.entitlement = key;
    throw error;
  }
  return snapshot;
}

module.exports = { publicLicense, getSnapshot, activeSnapshot, assertEntitlement, upsertFromRemotePayload, refreshLicense };
