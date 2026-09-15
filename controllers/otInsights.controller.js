const OTRequest = require('../models/OTRequest');
const { requireHospitalId } = require('../services/tenantScope.service');
const { buildDashboard, buildReports, buildAuditTimeline } = require('../services/otInsights.service');

exports.dashboard = async (req, res, next) => {
  try {
    const data = await buildDashboard(requireHospitalId(req));
    res.json({ success: true, data, stats: data.stats });
  } catch (error) { next(error); }
};

exports.reports = async (req, res, next) => {
  try {
    const data = await buildReports(requireHospitalId(req), req.query);
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.audit = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await OTRequest.findOne({ _id: req.params.id, hospitalId }).select('_id hospitalId admissionId patientId requestNumber');
    if (!otCase) return res.status(404).json({ success: false, error: 'OT case not found' });
    const events = await buildAuditTimeline(otCase);
    res.json({ success: true, data: events });
  } catch (error) { next(error); }
};
