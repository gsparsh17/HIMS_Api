const mongoose = require('mongoose');

function idString(value) {
  if (!value) return null;
  if (value._id) return String(value._id);
  return String(value);
}

function hospitalIdFromUser(user) {
  return user?.hospital_id || user?.hospitalId || user?.hospitalID || null;
}

function requireHospitalId(req) {
  const hospitalId = hospitalIdFromUser(req?.user);
  if (!hospitalId) {
    const error = new Error('Authenticated user is not linked to a hospital');
    error.statusCode = 403;
    throw error;
  }
  return hospitalId;
}

function tenantFilter(req, extra = {}, field = 'hospitalId') {
  return { ...extra, [field]: requireHospitalId(req) };
}

function tenantFilterSnake(req, extra = {}) {
  return tenantFilter(req, extra, 'hospital_id');
}

function assertSameHospital(req, record, fields = ['hospitalId', 'hospital_id']) {
  const expected = idString(requireHospitalId(req));
  const actual = fields.map((field) => record?.[field]).find(Boolean);
  if (!actual || idString(actual) !== expected) {
    const error = new Error('Record not found');
    error.statusCode = 404;
    throw error;
  }
  return record;
}

function objectId(value, label = 'id') {
  if (!mongoose.isValidObjectId(value)) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
  return new mongoose.Types.ObjectId(value);
}

module.exports = {
  idString,
  hospitalIdFromUser,
  requireHospitalId,
  tenantFilter,
  tenantFilterSnake,
  assertSameHospital,
  objectId
};
