function unwrapId(value) {
  if (!value) return null;
  if (value?._id) return value._id;
  if (
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'id') &&
    typeof value.id === 'string'
  ) {
    return value.id;
  }
  return value;
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
  userHospitalId,
  assertUserHospital,
  assertSameHospital,
  hospitalFilter,
  isPlatformAdmin,
  requestHospitalId,
  resolveHospitalId: requestHospitalId
};
