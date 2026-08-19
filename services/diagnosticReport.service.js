'use strict';

const crypto = require('crypto');
const { operationNow } = require('../utils/operationTimeContext');
const { queueNotification } = require('./nabhNotification.service');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function reportSnapshot(request) {
  return {
    status: request.status,
    reportMode: request.report_mode,
    reportUrl: request.report_url,
    manualReport: request.manual_report,
    reportFileName: request.report_file_name,
    reportMimeType: request.report_mime_type,
    reportFileSize: request.report_file_size,
    // Lab result content.
    resultValue: request.result_value,
    resultInterpretation: request.result_interpretation,
    normalRangeUsed: request.normal_range_used,
    isAbnormal: request.is_abnormal,
    // Radiology result content.
    findings: request.findings,
    impression: request.impression,
    images: request.images,
    reportedAt: request.reportedAt,
    reportedBy: request.reportedBy
  };
}

function checksum(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function finaliseDiagnosticReport(request, userId) {
  if (request.reportFinalisation?.isFinal) {
    const error = new Error('Report is already final. Create a controlled amendment instead.');
    error.statusCode = 409;
    throw error;
  }
  const snapshot = reportSnapshot(request);
  request.reportFinalisation = {
    isFinal: true,
    finalisedAt: operationNow(),
    finalisedBy: userId,
    checksum: checksum(snapshot),
    version: Number(request.reportFinalisation?.version || 0) + 1
  };
  return request.reportFinalisation;
}

async function amendDiagnosticReport({ request, userId, reason, patch }) {
  if (!request.reportFinalisation?.isFinal) {
    const error = new Error('Only final reports can be amended');
    error.statusCode = 409;
    throw error;
  }
  if (!String(reason || '').trim()) {
    const error = new Error('Amendment reason is required');
    error.statusCode = 400;
    throw error;
  }
  const previous = reportSnapshot(request);
  request.reportAmendments = request.reportAmendments || [];
  request.reportAmendments.push({
    version: request.reportFinalisation.version,
    reason: String(reason).trim(),
    previousReport: previous,
    previousChecksum: request.reportFinalisation.checksum,
    amendedAt: operationNow(),
    amendedBy: userId
  });
  const editableReportFields = new Set([
    'manual_report', 'report_url', 'report_mode', 'report_file_name',
    'report_mime_type', 'report_file_size', 'status',
    'result_value', 'result_interpretation', 'normal_range_used', 'is_abnormal',
    'findings', 'impression', 'images'
  ]);
  for (const [key, value] of Object.entries(patch || {})) {
    if (editableReportFields.has(key) && value !== undefined) {
      request[key] = value;
    }
  }
  request.reportFinalisation = {
    isFinal: true,
    finalisedAt: operationNow(),
    finalisedBy: userId,
    checksum: checksum(reportSnapshot(request)),
    version: Number(request.reportFinalisation.version || 1) + 1
  };
  return request;
}

async function notifyDiagnosticRelease({ request, hospitalId, type, userId, critical = false }) {
  const patient = request.patientId;
  const doctor = request.doctorId;
  const requestedChannels = ['portal'];
  const notifications = [];
  if (patient) {
    notifications.push(await queueNotification({
      hospitalId,
      eventType: `${type}_report_ready`,
      correlationId: String(request._id),
      recipientType: 'patient',
      recipientId: patient._id || patient,
      recipientName: patient.full_name || patient.first_name,
      contact: { email: patient.email, phone: patient.phone },
      requestedChannels: patient.phone ? [...requestedChannels, 'sms'] : requestedChannels,
      subject: `${type === 'lab' ? 'Laboratory' : 'Radiology'} report available`,
      body: `Your ${type === 'lab' ? 'laboratory' : 'radiology'} report ${request.requestNumber || ''} is available.`,
      priority: critical ? 'critical' : 'normal',
      requireAcknowledgement: critical,
      createdBy: userId
    }));
  }
  if (doctor) {
    notifications.push(await queueNotification({
      hospitalId,
      eventType: critical ? `${type}_critical_result` : `${type}_report_released`,
      correlationId: String(request._id),
      recipientType: 'doctor',
      recipientId: doctor._id || doctor,
      recipientName: [doctor.firstName, doctor.lastName].filter(Boolean).join(' '),
      contact: { email: doctor.email, phone: doctor.phone },
      requestedChannels: ['portal', ...(doctor.email ? ['email'] : [])],
      subject: critical ? 'Critical diagnostic result' : 'Diagnostic report released',
      body: `${type === 'lab' ? 'Laboratory' : 'Radiology'} report ${request.requestNumber || ''} has been released.`,
      priority: critical ? 'critical' : 'normal',
      requireAcknowledgement: critical,
      createdBy: userId
    }));
  }
  return notifications;
}

module.exports = {
  checksum,
  reportSnapshot,
  finaliseDiagnosticReport,
  amendDiagnosticReport,
  notifyDiagnosticRelease
};
