const Patient = require('../models/Patient');
const IPDAdmission = require('../models/IPDAdmission');
const { userHospitalId } = require('../utils/hospitalScope');
const { searchServiceCatalog } = require('../services/serviceCatalog.service');
const desk = require('../services/deskOrchestration.service');

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    code: error.code,
    details: error.details
  });
}

exports.searchPatients = async (req, res) => {
  try {
    const hospitalId = userHospitalId(req.user);
    const q = String(req.query.q || '').trim();

    if (q.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i');

    const patients = await Patient
      .find({
        hospitalId,
        $or: [
          { uhid: match },
          { patientId: match },
          { first_name: match },
          { middle_name: match },
          { last_name: match },
          { phone: match },
          { normalizedPhone: match },
          { 'abha.address': match }
        ]
      })
      .select('uhid patientId first_name middle_name last_name phone normalizedPhone gender dob patient_type')
      .limit(20)
      .lean();

    const ids = patients.map(p => p._id);

    const admissions = await IPDAdmission
      .find({
        hospitalId,
        patientId: { $in: ids },
        status: { $nin: ['Discharged', 'Cancelled'] }
      })
      .select('patientId admissionNumber status')
      .lean();

    const byPatient = new Map(admissions.map(a => [String(a.patientId), a]));

    return res.json({
      success: true,
      data: patients.map(p => ({
        ...p,
        activeAdmission: byPatient.get(String(p._id)) || null
      }))
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getPatientAdmissions = async (req, res) => {
  try {
    const hospitalId = userHospitalId(req.user);

    const admissions = await IPDAdmission
      .find({
        hospitalId,
        patientId: req.params.patientId,
        status: { $nin: ['Discharged', 'Cancelled'] }
      })
      .select('admissionNumber ipdNumber status wardId bedId admissionDate consultantId')
      .populate('wardId', 'name')
      .populate('bedId', 'bedNumber type')
      .sort({ admissionDate: -1 })
      .lean();

    return res.json({
      success: true,
      data: admissions.map(row => ({
        ...row,
        wardName: row.wardId?.name,
        bedNumber: row.bedId?.bedNumber,
        bedType: row.bedId?.type
      }))
    });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.searchServices = async (req, res) => {
  try {
    const data = await searchServiceCatalog({
      user: req.user,
      query: req.query.q,
      encounterType: req.query.encounterType,
      limit: req.query.limit
    });

    return res.json({ success: true, data });
  } catch (e) {
    return sendError(res, e);
  }
};


exports.quoteServices = async (req, res) => {
  try {
    const data = await desk.quoteDeskServices(req.body || {}, req.user);
    return res.json({ success: true, data });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.preview = async (req, res) => {
  try {
    const data = await desk.previewDeskCheckout(req.body, req.user);
    return res.json({ success: true, data });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.commit = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey
    };

    const data = await desk.commitDeskCheckout(payload, req.user);

    return res.status(201).json({ success: true, data });
  } catch (e) {
    return sendError(res, e);
  }
};