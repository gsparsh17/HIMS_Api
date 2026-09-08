'use strict';

const mongoose = require('mongoose');
const HospitalPharmacySetting = require('../models/HospitalPharmacySetting');
const { findActivePharmacyIdForHospital } = require('./pharmacyResolver.service');
const IPDAdmission = require('../models/IPDAdmission');

const BILLING_OWNERS = Object.freeze({
  PHARMACY: 'PHARMACY',
  IPD_CONSOLIDATED: 'IPD_CONSOLIDATED'
});

function sessionOption(session) {
  return session ? { session } : {};
}

function normalizeBillingOwner(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === BILLING_OWNERS.IPD_CONSOLIDATED
    ? BILLING_OWNERS.IPD_CONSOLIDATED
    : BILLING_OWNERS.PHARMACY;
}

function policyFromAdmission(admission) {
  const snapshot = admission?.pharmacyBillingPolicySnapshot || {};
  if (snapshot?.billingOwner) {
    return {
      billingOwner: normalizeBillingOwner(snapshot.billingOwner),
      source: snapshot.source || 'ADMISSION_SNAPSHOT',
      settingId: snapshot.settingId || undefined,
      pharmacyId: snapshot.pharmacyId || undefined,
      resolvedAt: snapshot.resolvedAt || undefined,
      version: Number(snapshot.version || 1)
    };
  }

  // Existing admissions pre-date this feature. They must retain the historical
  // behaviour even if an administrator switches the hospital default today.
  return {
    billingOwner: BILLING_OWNERS.PHARMACY,
    source: 'LEGACY_ADMISSION_DEFAULT',
    version: 1
  };
}

async function resolveHospitalDefault({ hospitalId, pharmacyId, session } = {}) {
  if (!hospitalId || !mongoose.Types.ObjectId.isValid(String(hospitalId))) {
    return { billingOwner: BILLING_OWNERS.PHARMACY, source: 'SYSTEM_DEFAULT', version: 1 };
  }

  const base = { hospitalId };
  let effectivePharmacyId = pharmacyId;
  if (!effectivePharmacyId || !mongoose.Types.ObjectId.isValid(String(effectivePharmacyId))) {
    effectivePharmacyId = await findActivePharmacyIdForHospital(hospitalId, null, session);
  }

  let setting = null;
  if (effectivePharmacyId && mongoose.Types.ObjectId.isValid(String(effectivePharmacyId))) {
    setting = await HospitalPharmacySetting.findOne({ ...base, pharmacyId: effectivePharmacyId }, null, sessionOption(session)).lean();
  }
  if (!setting) {
    setting = await HospitalPharmacySetting.findOne(base, null, sessionOption(session)).sort({ createdAt: 1 }).lean();
  }

  return {
    billingOwner: normalizeBillingOwner(setting?.ipdPharmacyBillingOwner),
    source: setting ? 'HOSPITAL_PHARMACY_SETTING' : 'SYSTEM_DEFAULT',
    settingId: setting?._id,
    pharmacyId: setting?.pharmacyId,
    version: 1
  };
}

async function snapshotAdmissionPolicy({ admission, admissionId, hospitalId, pharmacyId, userId, session } = {}) {
  let doc = admission;
  if (!doc && admissionId) {
    doc = await IPDAdmission.findOne({ _id: admissionId, ...(hospitalId ? { hospitalId } : {}) }, null, sessionOption(session));
  }
  if (!doc) {
    const error = new Error('Admission not found while resolving IPD Pharmacy Billing Ownership');
    error.statusCode = 404;
    throw error;
  }

  if (doc.pharmacyBillingPolicySnapshot?.billingOwner) return policyFromAdmission(doc);

  const resolved = await resolveHospitalDefault({ hospitalId: doc.hospitalId || hospitalId, pharmacyId, session });
  const snapshot = {
    billingOwner: resolved.billingOwner,
    source: resolved.source,
    settingId: resolved.settingId,
    pharmacyId: resolved.pharmacyId,
    resolvedAt: new Date(),
    resolvedBy: userId,
    version: 1
  };

  doc.pharmacyBillingPolicySnapshot = snapshot;
  await doc.save({ validateBeforeSave: false, ...sessionOption(session) });
  return { ...resolved, resolvedAt: snapshot.resolvedAt };
}

async function resolveAdmissionPolicy({ admission, admissionId, hospitalId, session } = {}) {
  let doc = admission;
  if (!doc && admissionId) {
    doc = await IPDAdmission.findOne({ _id: admissionId, ...(hospitalId ? { hospitalId } : {}) }, null, sessionOption(session)).lean();
  }
  if (!doc) {
    const error = new Error('Admission not found while resolving IPD Pharmacy Billing Ownership');
    error.statusCode = 404;
    throw error;
  }
  return policyFromAdmission(doc);
}

function ipdOwnsPharmacyBilling(admissionOrPolicy) {
  const policy = admissionOrPolicy?.billingOwner
    ? admissionOrPolicy
    : policyFromAdmission(admissionOrPolicy);
  return normalizeBillingOwner(policy.billingOwner) === BILLING_OWNERS.IPD_CONSOLIDATED;
}

module.exports = {
  BILLING_OWNERS,
  normalizeBillingOwner,
  policyFromAdmission,
  resolveHospitalDefault,
  snapshotAdmissionPolicy,
  resolveAdmissionPolicy,
  ipdOwnsPharmacyBilling
};
