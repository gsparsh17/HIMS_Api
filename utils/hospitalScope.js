function userHospitalId(user) {
  return user?.hospital_id || user?.hospitalId || null;
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
  if (!ownerHospitalId || String(ownerHospitalId) !== String(hospitalId)) {
    const error = new Error('Cross-hospital access is not permitted');
    error.statusCode = 403;
    throw error;
  }
  return hospitalId;
}

function hospitalFilter(user, field = 'hospitalId') {
  return { [field]: assertUserHospital(user) };
}

module.exports = {
  userHospitalId,
  assertUserHospital,
  assertSameHospital,
  hospitalFilter
};
