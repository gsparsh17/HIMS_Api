'use strict';

const mongoose = require('mongoose');
const Pharmacy = require('../models/Pharmacy');
const HospitalPharmacySetting = require('../models/HospitalPharmacySetting');

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function activeFilter(extra = {}) {
  return {
    ...extra,
    status: 'Active',
    is_active: { $ne: false }
  };
}

async function pharmacyLinkedToHospital(pharmacyId, hospitalId, session = null) {
  if (!pharmacyId || !hospitalId) return false;
  const query = HospitalPharmacySetting.exists({ hospitalId, pharmacyId });
  const result = await withSession(query, session);
  return Boolean(result);
}

async function uniqueLegacyActivePharmacy(session = null) {
  // Older MediQliq pharmacy rows pre-date hospitalId on the Pharmacy model.
  // Only use a legacy unscoped row when it is unambiguous. If more than one
  // active legacy pharmacy exists, fail closed instead of assigning one to the
  // wrong hospital.
  const query = Pharmacy.find(activeFilter({
    $or: [
      { hospitalId: { $exists: false } },
      { hospitalId: null }
    ]
  }))
    .sort({ registeredAt: 1, _id: 1 })
    .limit(2);
  const rows = await withSession(query, session);
  return rows.length === 1 ? rows[0] : null;
}

async function findActivePharmacyForHospital(hospitalId, preferredPharmacyId = null, session = null) {
  if (!hospitalId || !mongoose.Types.ObjectId.isValid(String(hospitalId))) {
    throw new Error('Hospital context is required before selecting a pharmacy.');
  }

  const hospitalObjectId = new mongoose.Types.ObjectId(String(hospitalId));

  if (preferredPharmacyId && mongoose.Types.ObjectId.isValid(String(preferredPharmacyId))) {
    const preferredId = new mongoose.Types.ObjectId(String(preferredPharmacyId));
    const preferred = await withSession(
      Pharmacy.findOne(activeFilter({ _id: preferredId })),
      session
    );

    if (preferred) {
      if (preferred.hospitalId && String(preferred.hospitalId) === String(hospitalObjectId)) {
        return preferred;
      }

      if (await pharmacyLinkedToHospital(preferred._id, hospitalObjectId, session)) {
        return preferred;
      }

      // Legacy single-hospital deployments may have exactly one Pharmacy row
      // created before hospitalId existed on the schema.
      if (!preferred.hospitalId) {
        const legacy = await uniqueLegacyActivePharmacy(session);
        if (legacy && String(legacy._id) === String(preferred._id)) return preferred;
      }
    }
  }

  // Prefer the explicit hospital -> pharmacy mapping because this is already
  // the source used by HospitalPharmacySetting and preserves existing setups.
  const settingQuery = HospitalPharmacySetting.findOne({
    hospitalId: hospitalObjectId,
    pharmacyId: { $ne: null }
  }).sort({ createdAt: 1, _id: 1 });
  const setting = await withSession(settingQuery, session);
  if (setting?.pharmacyId) {
    const linked = await withSession(
      Pharmacy.findOne(activeFilter({ _id: setting.pharmacyId })),
      session
    );
    if (linked) return linked;
  }

  // New pharmacy rows are directly hospital scoped.
  const directQuery = Pharmacy.findOne(activeFilter({ hospitalId: hospitalObjectId }))
    .sort({ registeredAt: 1, _id: 1 });
  const direct = await withSession(directQuery, session);
  if (direct) return direct;

  // Backward-compatible bootstrap for older single-hospital databases.
  return uniqueLegacyActivePharmacy(session);
}

async function findActivePharmacyIdForHospital(hospitalId, preferredPharmacyId = null, session = null) {
  const pharmacy = await findActivePharmacyForHospital(hospitalId, preferredPharmacyId, session);
  return pharmacy?._id || null;
}

module.exports = {
  findActivePharmacyForHospital,
  findActivePharmacyIdForHospital
};
