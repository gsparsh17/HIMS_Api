const mongoose = require('mongoose');

function unwrapId(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'object') {
    if (value?._id !== undefined && value?._id !== value) return unwrapId(value._id);
    if (Object.prototype.hasOwnProperty.call(value, '$oid')) return unwrapId(value.$oid);
    if (
      Object.prototype.hasOwnProperty.call(value, 'id') &&
      typeof value.id === 'string'
    ) {
      return unwrapId(value.id);
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Legacy/imported Extended JSON occasionally persisted the whole
    // {"$oid":"..."} object as a string. Accept it at read boundaries so
    // old rows cannot crash tenant-scoped queries.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && parsed.$oid) {
          return unwrapId(parsed.$oid);
        }
      } catch {
        // Keep the original value; callers that require ObjectId validity
        // will reject it explicitly.
      }
    }

    // Also tolerate common textual ObjectId("...") exports.
    const objectIdMatch = trimmed.match(/^ObjectId\s*\(\s*["']?([a-fA-F0-9]{24})["']?\s*\)$/);
    if (objectIdMatch) return objectIdMatch[1];

    return trimmed;
  }

  return value;
}

function normalizeObjectId(value) {
  const unwrapped = unwrapId(value);
  if (!unwrapped || !mongoose.isValidObjectId(unwrapped)) return null;
  return unwrapped instanceof mongoose.Types.ObjectId
    ? unwrapped
    : new mongoose.Types.ObjectId(String(unwrapped));
}

function userHospitalId(user) {
  return unwrapId(
    user?.hospital_id ||
      user?.hospitalId ||
      user?.hospitalID ||
      user?.hospital
  );
}

function assertUserHospital(user) {
  const hospitalId = userHospitalId(user);
  if (!hospitalId) {
    const error = new Error('Authenticated user is not assigned to a hospital');
    error.statusCode = 403;
    throw error;
  }
  return hospitalId;
}

function assertSameHospital(ownerHospitalId, user) {
  const hospitalId = assertUserHospital(user);
  if (!ownerHospitalId || String(unwrapId(ownerHospitalId)) !== String(hospitalId)) {
    const error = new Error('Cross-hospital access is not permitted');
    error.statusCode = 403;
    throw error;
  }
  return hospitalId;
}

function hospitalFilter(user, field = 'hospitalId') {
  return { [field]: assertUserHospital(user) };
}

function isPlatformAdmin(user) {
  const role = String(user?.role || '').trim().toLowerCase();
  return role === 'mediqliq_super_admin' || role === 'super_admin';
}

/**
 * Resolve a hospital from the authenticated user first. Request-controlled
 * values are accepted only for platform admins, preventing tenant switching
 * through body/query/header casing variants.
 */
function requestHospitalId(req, { required = true } = {}) {
  const authenticatedHospitalId = userHospitalId(req?.user);
  if (authenticatedHospitalId) return authenticatedHospitalId;

  if (isPlatformAdmin(req?.user)) {
    const requested = unwrapId(
      req?.hospital_id ||
        req?.hospitalId ||
        req?.headers?.['x-hospital-id'] ||
        req?.body?.hospitalId ||
        req?.body?.hospital_id ||
        req?.query?.hospitalId ||
        req?.query?.hospital_id ||
        req?.params?.hospitalId ||
        req?.params?.hospital_id
    );
    if (requested) return requested;
  }

  if (!required) return null;
  const error = new Error('Hospital context is required');
  error.statusCode = 403;
  throw error;
}

module.exports = {
  unwrapId,
  normalizeObjectId,
  userHospitalId,
  assertUserHospital,
  assertSameHospital,
  hospitalFilter,
  isPlatformAdmin,
  requestHospitalId,
  resolveHospitalId: requestHospitalId
};
