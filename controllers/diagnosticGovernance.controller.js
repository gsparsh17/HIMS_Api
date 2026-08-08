'use strict';

const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const { requireHospitalId } = require('../services/tenantScope.service');
const {
  amendDiagnosticReport,
  notifyDiagnosticRelease
} = require('../services/diagnosticReport.service');

function modelFor(type) {
  if (type === 'lab') return LabRequest;
  if (type === 'radiology') return RadiologyRequest;
  throw new Error('Unsupported diagnostic type');
}

async function findRequest(req, type, populate = false) {
  const hospitalId = requireHospitalId(req);
  let query = modelFor(type).findOne({ _id: req.params.id, hospitalId });
  if (populate) {
    query = query
      .populate('patientId', 'first_name last_name full_name phone email')
      .populate('doctorId', 'firstName lastName phone email');
  }
  const request = await query;
  if (!request) {
    const error = new Error(`${type === 'lab' ? 'Lab' : 'Radiology'} request not found`);
    error.statusCode = 404;
    throw error;
  }
  return { request, hospitalId };
}

function safePatch(body) {
  return {
    manual_report: body.manual_report,
    report_url: body.report_url,
    report_mode: body.report_mode,
    report_file_name: body.report_file_name,
    report_mime_type: body.report_mime_type,
    report_file_size: body.report_file_size,
    result_value: body.result_value,
    result_interpretation: body.result_interpretation,
    normal_range_used: body.normal_range_used,
    is_abnormal: body.is_abnormal,
    findings: body.findings,
    impression: body.impression,
    images: body.images,
    status: 'Amended'
  };
}

function respondError(res, error) {
  return res.status(error.statusCode || 400).json({ success: false, error: error.message });
}

function amendmentHandler(type) {
  return async (req, res) => {
    try {
      const { request, hospitalId } = await findRequest(req, type, true);
      await amendDiagnosticReport({
        request,
        userId: req.user._id,
        reason: req.body.reason,
        patch: safePatch(req.body)
      });
      request.workflowHistory = request.workflowHistory || [];
      request.workflowHistory.push({
        from: 'Reported',
        to: 'Amended',
        at: new Date(),
        by: req.user._id,
        note: String(req.body.reason).trim()
      });
      await request.save();
      const deliveries = await notifyDiagnosticRelease({
        request,
        hospitalId,
        type,
        userId: req.user._id,
        critical: Boolean(request.critical?.isCritical)
      });
      request.notificationDeliveryIds = [
        ...(request.notificationDeliveryIds || []),
        ...deliveries.map((row) => row._id)
      ];
      await request.save();
      return res.json({ success: true, message: 'Controlled report amendment saved', data: request });
    } catch (error) {
      return respondError(res, error);
    }
  };
}

function repeatHandler(type) {
  return async (req, res) => {
    try {
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Repeat reason is required' });
      const { request } = await findRequest(req, type);
      request.repeatHistory = request.repeatHistory || [];
      request.repeatHistory.push({
        reason,
        requestedAt: new Date(),
        requestedBy: req.user._id,
        previousStatus: request.status,
        previousAccessionNumber: request.accessionNumber
      });
      request.status = type === 'lab' ? 'Approved' : 'Scheduled';
      request.reportFinalisation = {
        isFinal: false,
        version: Number(request.reportFinalisation?.version || 0)
      };
      request.workflowHistory = request.workflowHistory || [];
      request.workflowHistory.push({
        from: request.repeatHistory.at(-1).previousStatus,
        to: request.status,
        at: new Date(),
        by: req.user._id,
        note: `Repeat requested: ${reason}`
      });
      await request.save();
      return res.json({ success: true, message: 'Repeat workflow started', data: request });
    } catch (error) {
      return respondError(res, error);
    }
  };
}

exports.amendLabReport = amendmentHandler('lab');
exports.repeatLabTest = repeatHandler('lab');
exports.amendRadiologyReport = amendmentHandler('radiology');
exports.repeatRadiologyStudy = repeatHandler('radiology');

exports.assessRadiologyContraindications = async (req, res) => {
  try {
    const { request } = await findRequest(req, 'radiology');
    const allowedDecisions = ['pending', 'proceed', 'proceed_with_precautions', 'defer', 'cancel'];
    if (!allowedDecisions.includes(req.body.decision || 'pending')) {
      return res.status(400).json({ error: 'Invalid contraindication decision' });
    }
    request.contraindicationAssessment = {
      ...(request.contraindicationAssessment?.toObject?.() || request.contraindicationAssessment || {}),
      ...req.body,
      assessedAt: new Date(),
      assessedBy: req.user._id
    };
    await request.save();
    return res.json({ success: true, data: request.contraindicationAssessment });
  } catch (error) {
    return respondError(res, error);
  }
};

exports.acknowledgeRadiologyContraindications = async (req, res) => {
  try {
    const { request } = await findRequest(req, 'radiology');
    if (!request.contraindicationAssessment?.assessedAt) {
      return res.status(409).json({ error: 'Contraindications must be assessed first' });
    }
    request.contraindicationAssessment.acknowledgedAt = new Date();
    request.contraindicationAssessment.acknowledgedBy = req.user._id;
    await request.save();
    return res.json({ success: true, data: request.contraindicationAssessment });
  } catch (error) {
    return respondError(res, error);
  }
};

exports.importDicomMetadata = async (req, res) => {
  try {
    const { request } = await findRequest(req, 'radiology');
    if (!String(req.body.studyInstanceUid || '').trim()) {
      return res.status(400).json({ error: 'studyInstanceUid is required' });
    }
    request.dicomMetadata = {
      ...req.body,
      importedAt: new Date(),
      importedBy: req.user._id
    };
    await request.save();
    return res.json({ success: true, data: request.dicomMetadata });
  } catch (error) {
    return respondError(res, error);
  }
};
