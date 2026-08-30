'use strict';

const Nurse = require('../models/Nurse');
const Doctor = require('../models/Doctor');
const HRStaffProfile = require('../models/HRStaffProfile');
const User = require('../models/User');
const { hospitalIdFromUser } = require('./tenantScope.service');

function actorName(user) {
  return String(user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || '').trim();
}

async function resolveClinicalActor(user, { session = null } = {}) {
  if (!user?._id) return { userId: null, role: '', name: '' };
  const opts = session ? { session } : {};
  const role = String(user.role || '').toLowerCase();
  const hospitalId = hospitalIdFromUser(user);
  let staffProfileId = null;
  let staffModel = null;
  let resolvedName = actorName(user);

  // HRStaffProfile is the canonical User <-> clinical staff bridge. Nurse does
  // not carry a user_id field in its own schema, so looking up Nurse by a User
  // ObjectId can silently fail. Resolve through HR first, then verify the actual
  // Doctor/Nurse record and hospital before writing a typed foreign-key ref.
  const hrFilter = { user_id: user._id };
  if (hospitalId) hrFilter.hospital_id = hospitalId;
  const hrProfile = await HRStaffProfile.findOne(hrFilter, 'doctor_id nurse_id full_name source_model source_id', opts).lean();

  if (role === 'doctor') {
    const candidates = [];
    if (hrProfile?.doctor_id) candidates.push({ _id: hrProfile.doctor_id });
    candidates.push({ user_id: user._id });
    if (user.email) candidates.push({ email: String(user.email).toLowerCase().trim() });
    const doctorFilter = { $or: candidates };
    if (hospitalId) doctorFilter.hospitalId = hospitalId;
    const row = await Doctor.findOne(doctorFilter, '_id firstName lastName', opts).lean();
    if (row) {
      staffProfileId = row._id;
      staffModel = 'Doctor';
      resolvedName = String([row.firstName, row.lastName].filter(Boolean).join(' ') || hrProfile?.full_name || resolvedName).trim();
    }
  } else if (role === 'nurse') {
    const candidates = [];
    if (hrProfile?.nurse_id) candidates.push({ _id: hrProfile.nurse_id });
    if (hrProfile?.source_model === 'Nurse' && hrProfile?.source_id) candidates.push({ _id: hrProfile.source_id });
    if (user.email) candidates.push({ email: String(user.email).toLowerCase().trim() });
    if (candidates.length) {
      const nurseFilter = { $or: candidates };
      if (hospitalId) nurseFilter.hospitalId = hospitalId;
      const row = await Nurse.findOne(nurseFilter, '_id first_name last_name', opts).lean();
      if (row) {
        staffProfileId = row._id;
        staffModel = 'Nurse';
        resolvedName = String([row.first_name, row.last_name].filter(Boolean).join(' ') || hrProfile?.full_name || resolvedName).trim();
      }
    }
  }

  return {
    userId: user._id,
    role: user.role || '',
    name: resolvedName,
    staffProfileId,
    staffModel
  };
}

async function resolveNurseWitness({ hospitalId, userId = null, nurseId = null, session = null }) {
  const opts = session ? { session } : {};
  let nurse = null;
  let user = null;
  let hrProfile = null;

  if (userId) {
    user = await User.findOne({ _id: userId, hospital_id: hospitalId }, 'name email role hospital_id', opts).lean();
    if (!user) return null;
    const actor = await resolveClinicalActor(user, { session });
    if (actor.staffModel !== 'Nurse' || !actor.staffProfileId) return null;
    nurse = await Nurse.findOne({ _id: actor.staffProfileId, hospitalId }, '_id first_name last_name', opts).lean();
    if (!nurse) return null;
    return { userId: user._id, nurseProfileId: nurse._id, name: actor.name || actorName(user) };
  }

  if (nurseId) {
    nurse = await Nurse.findOne({ _id: nurseId, hospitalId }, '_id first_name last_name email', opts).lean();
    if (!nurse) return null;
    hrProfile = await HRStaffProfile.findOne({ nurse_id: nurse._id, hospital_id: hospitalId }, 'user_id full_name', opts).lean();
    if (hrProfile?.user_id) user = await User.findOne({ _id: hrProfile.user_id, hospital_id: hospitalId }, 'name email role hospital_id', opts).lean();
    return {
      userId: user?._id || null,
      nurseProfileId: nurse._id,
      name: String(hrProfile?.full_name || [nurse.first_name, nurse.last_name].filter(Boolean).join(' ') || actorName(user)).trim()
    };
  }

  return null;
}

module.exports = { resolveClinicalActor, resolveNurseWitness, actorName };
