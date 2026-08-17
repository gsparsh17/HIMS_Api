const mongoose = require('mongoose');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const CoverageUtilization = require('../models/CoverageUtilization');
const PackageEpisode = require('../models/PackageEpisode');
const { requireHospitalId } = require('../services/tenantScope.service');
const coverageService = require('../services/coverage.service');

function fail(res, error) {
  res.status(error.statusCode || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await work(session); }); return result; } finally { await session.endSession(); }
}
function encounter(req) {
  if (req.params.appointmentId) return { encounterType: 'OPD', encounterId: req.params.appointmentId, appointmentId: req.params.appointmentId };
  return { encounterType: 'IPD', encounterId: req.params.admissionId || req.params.id, admissionId: req.params.admissionId || req.params.id };
}

exports.create = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req); const e = encounter(req);
    const data = await transaction((session) => coverageService.createEncounterCoverage({ req, hospitalId, encounterType: e.encounterType, encounterId: e.encounterId, payload: req.body, activateImmediately: req.body.activateImmediately !== false, session }));
    res.status(201).json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.get = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req); const e = encounter(req);
    const filter = { hospitalId, encounterType: e.encounterType, active: true };
    if (e.encounterType === 'OPD') filter.appointmentId = e.encounterId; else filter.admissionId = e.encounterId;
    const data = await AdmissionCoverage.findOne(filter).populate('payerId').populate('tpaId').populate('rateCardId');
    if (!data) {
      if (e.encounterType === 'OPD') await coverageService.tenantAppointment(hospitalId, e.encounterId); else await coverageService.tenantAdmission(hospitalId, e.encounterId);
      return res.json({ success: true, data: null, meta: { hasActiveCoverage: false, caseType: 'self_pay', encounterType: e.encounterType } });
    }
    return res.json({ success: true, data, meta: { hasActiveCoverage: true, caseType: 'sponsored', encounterType: e.encounterType } });
  } catch (error) { fail(res, error); }
};

exports.history = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req); const e = encounter(req);
    const filter = { hospitalId, encounterType: e.encounterType };
    if (e.encounterType === 'OPD') filter.appointmentId = e.encounterId; else filter.admissionId = e.encounterId;
    const data = await AdmissionCoverage.find(filter).populate('payerId', 'code name type').populate('rateCardId', 'name version status').sort({ createdAt: -1 });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.verify = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req); const e = encounter(req);
    const data = await transaction((session) => coverageService.updateEligibility({ req, hospitalId, ...e, coverageId: req.params.coverageId, payload: req.body, session }));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.preauth = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req); const e = encounter(req);
    const data = await transaction((session) => coverageService.updatePreAuth({ req, hospitalId, ...e, coverageId: req.params.coverageId, payload: req.body, session }));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.updatePreauthById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const coverage = await AdmissionCoverage.findOne({ _id: req.params.id, hospitalId });
    if (!coverage) return res.status(404).json({ success: false, error: 'Coverage not found' });
    const data = await transaction((session) => coverageService.updatePreAuth({ req, hospitalId, admissionId: coverage.admissionId, appointmentId: coverage.appointmentId, coverageId: coverage._id, payload: req.body, session }));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};


exports.updateSchemeDetails = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await transaction((session) => coverageService.updateSchemeData({ req, hospitalId, coverageId: req.params.id, payload: req.body, session }));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.activate = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await transaction((session) => coverageService.activatePreparedCoverage({ req, hospitalId, coverageId: req.params.id, session }));
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.utilization = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const coverage = await AdmissionCoverage.findOne({ _id: req.params.id, hospitalId })
      .populate('payerId', 'code name type')
      .populate('rateCardId', 'name version status');
    if (!coverage) return res.status(404).json({ success: false, error: 'Coverage not found' });
    const [utilization, packages] = await Promise.all([
      CoverageUtilization.find({ hospitalId, coverageId: coverage._id }).sort({ createdAt: 1 }).lean(),
      PackageEpisode.find({ hospitalId, coverageId: coverage._id }).sort({ startsAt: 1 }).lean()
    ]);
    const active = utilization.filter((row) => row.status === 'active');
    const totals = active.reduce((sum, row) => {
      for (const key of ['eligibleAmount', 'sponsorLiability', 'patientLiability', 'coPayAmount', 'deductibleAmount', 'fixedPatientShare', 'uncoveredAmount']) {
        sum[key] = Number((sum[key] + Number(row.amounts?.[key] || 0)).toFixed(2));
      }
      return sum;
    }, { eligibleAmount: 0, sponsorLiability: 0, patientLiability: 0, coPayAmount: 0, deductibleAmount: 0, fixedPatientShare: 0, uncoveredAmount: 0 });
    return res.json({ success: true, data: { coverage, totals, utilization, packages } });
  } catch (error) { return fail(res, error); }
};
