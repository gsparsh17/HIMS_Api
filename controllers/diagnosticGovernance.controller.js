'use strict';

const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const { requireHospitalId } = require('../services/tenantScope.service');
const {
  amendDiagnosticReport,
  notifyDiagnosticRelease,
  reportSnapshot
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
    recommendations: body.recommendations,
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
        patch: safePatch(req.body),
        reopenForVerification: type === 'radiology'
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
      if (type !== 'radiology') {
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
      }
      return res.json({
        success: true,
        message: type === 'radiology'
          ? 'Controlled amendment saved. Verification and release are required.'
          : 'Controlled report amendment saved',
        data: request
      });
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

      const previousStatus = request.status;
      const historyEntry = {
        reason,
        requestedAt: new Date(),
        requestedBy: req.user._id,
        previousStatus,
        previousAccessionNumber: request.accessionNumber
      };

      if (type === 'radiology') {
        historyEntry.previousReport = reportSnapshot(request);
        historyEntry.previousReportFinalisation = request.reportFinalisation?.toObject?.() || request.reportFinalisation || null;
        historyEntry.previousSchedule = {
          modality: request.modality,
          scheduledStart: request.scheduledStart,
          scheduledEnd: request.scheduledEnd,
          assignedTechnician: request.assignedTechnician,
          assignedRadiologist: request.assignedRadiologist,
          contrastRequired: request.contrastRequired
        };
      }
      request.repeatHistory.push(historyEntry);

      if (type === 'radiology') {
        const instructions = String(request.patientPreparation?.instructions || '').trim();
        request.status = 'Approved';
        request.scheduledStart = undefined;
        request.scheduledEnd = undefined;
        request.assignedTechnician = undefined;
        request.assignedRadiologist = undefined;
        request.performedAt = undefined;
        request.performedBy = undefined;
        request.findings = undefined;
        request.impression = undefined;
        request.recommendations = undefined;
        request.manual_report = undefined;
        request.report_url = undefined;
        request.report_mode = undefined;
        request.report_file_name = undefined;
        request.report_mime_type = undefined;
        request.report_file_size = undefined;
        request.resultEnteredAt = undefined;
        request.verifiedAt = undefined;
        request.verifiedByUserId = undefined;
        request.releasedAt = undefined;
        request.releasedBy = undefined;
        request.reportedAt = undefined;
        request.reportedBy = undefined;
        request.reportFinalisation = {
          isFinal: false,
          version: Number(historyEntry.previousReportFinalisation?.version || 0)
        };
        request.patientPreparation = {
          ...(request.patientPreparation?.toObject?.() || request.patientPreparation || {}),
          status: instructions ? 'pending' : 'not_required',
          completedAt: undefined,
          completedBy: undefined
        };
        request.safetyChecklist = undefined;
        request.contraindicationAssessment = {
          pregnancyStatus: 'not_applicable',
          renalRisk: 'not_assessed',
          contrastAllergy: false,
          implantOrDevice: '',
          claustrophobia: false,
          otherRisks: [],
          decision: 'pending',
          precautions: []
        };
      } else {
        request.status = 'Approved';
        request.reportFinalisation = {
          isFinal: false,
          version: Number(request.reportFinalisation?.version || 0)
        };
      }

      request.workflowHistory = request.workflowHistory || [];
      request.workflowHistory.push({
        from: previousStatus,
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
    if (!['Pending', 'Approved', 'Scheduled'].includes(request.status)) {
      return res.status(409).json({ error: 'Safety assessment can only be changed before the imaging study starts' });
    }
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
    if (!['Pending', 'Approved', 'Scheduled'].includes(request.status)) {
      return res.status(409).json({ error: 'Safety assessment can only be acknowledged before the imaging study starts' });
    }
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
