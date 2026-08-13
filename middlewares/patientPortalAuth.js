const jwt = require('jsonwebtoken');
const Patient = require('../models/Patient');

function tokenFromRequest(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

exports.requirePatientPortal = async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    if (!token) return res.status(401).json({ success: false, error: 'Patient session required' });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (!claims.patientPortal || !claims.patientId || !claims.hospitalId) {
      return res.status(403).json({ success: false, error: 'Invalid patient portal session' });
    }
    const patient = await Patient.findOne({ _id: claims.patientId, hospitalId: claims.hospitalId });
    if (!patient) return res.status(401).json({ success: false, error: 'Patient account not found' });
    req.patient = patient;
    req.patientPortal = claims;
    req.hospitalId = patient.hospitalId;
    req.hospital_id = patient.hospitalId;
    return next();
  } catch (error) {
    const message = error.name === 'TokenExpiredError' ? 'Patient session expired' : 'Invalid patient session';
    return res.status(401).json({ success: false, error: message });
  }
};
