const Hospital = require('../models/Hospital');

function hospitalIdsForUser(user) {
  const values = [user?.hospital_id, user?.primary_hospital_id, ...(user?.hospital_ids || [])]
    .filter(Boolean)
    .map((item) => item?._id || item);
  return values.filter((value, index) => values.findIndex((other) => String(other) === String(value)) === index);
}

exports.scopeToHospital = async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    if (['mediqliq_super_admin', 'super_admin'].includes(req.user.role)) {
      if (req.query.hospital_id) {
        const hospital = await Hospital.findById(req.query.hospital_id);
        if (!hospital) return res.status(400).json({ error: 'Hospital not found' });
        req.hospital_id = hospital._id;
        req.hospital_ids = [hospital._id];
      }
      return next();
    }

    const hospitalIds = hospitalIdsForUser(req.user);
    if (!hospitalIds.length) return res.status(403).json({ error: 'User is not assigned to a hospital' });

    const requested = req.query.hospital_id || req.params.hospitalId || req.params.hospital_id || req.body?.hospital_id;
    if (requested && !hospitalIds.some((id) => String(id) === String(requested))) {
      return res.status(403).json({ error: 'No access to requested hospital' });
    }

    req.hospital_id = requested || hospitalIds[0];
    req.hospital_ids = requested ? [requested] : hospitalIds;
    req.user_hospital_id = req.hospital_id;
    req.user_hospital_ids = req.hospital_ids;
    return next();
  } catch (error) {
    console.error('Hospital scope error:', error);
    return res.status(500).json({ error: 'Failed to determine hospital context' });
  }
};

exports.requireHospitalContext = (req, res, next) => {
  if (!req.hospital_id) return res.status(400).json({ error: 'Hospital context required for this operation' });
  return next();
};

exports.checkHospitalAccess = (paramName = 'hospitalId') => (req, res, next) => {
  const hospitalId = req.params[paramName] || req.query.hospital_id;
  if (!hospitalId || ['mediqliq_super_admin', 'super_admin'].includes(req.user?.role)) return next();
  const hasAccess = (req.user_hospital_ids || hospitalIdsForUser(req.user)).some((id) => String(id) === String(hospitalId));
  if (!hasAccess) return res.status(403).json({ error: 'No access to this hospital' });
  return next();
};
