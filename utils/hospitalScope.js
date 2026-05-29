const Hospital = require('../models/Hospital');

const toObjectIdString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value._id) return value._id.toString();
  return value.toString();
};

async function resolveHospitalId(req) {
  const fromUser = req?.user?.hospital_id || req?.user?.hospitalID || req?.user?.hospitalId;
  const fromBody = req?.body?.hospital_id || req?.body?.hospitalID || req?.body?.hospitalId;
  const fromQuery = req?.query?.hospital_id || req?.query?.hospitalID || req?.query?.hospitalId;
  const resolved = toObjectIdString(fromUser || fromBody || fromQuery);
  if (resolved) return resolved;

  const hospital = await Hospital.findOne({}).select('_id');
  return hospital?._id || null;
}

function scopedFilter(req, extra = {}) {
  const filter = { ...extra };
  const hospitalId = req?.user?.hospital_id || req?.body?.hospital_id || req?.query?.hospital_id;
  if (hospitalId) filter.hospital_id = hospitalId;
  return filter;
}

module.exports = {
  resolveHospitalId,
  scopedFilter
};
