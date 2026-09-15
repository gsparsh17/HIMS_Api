const { operationNow } = require('../utils/operationTimeContext');
const { appendDomainEvent } = require('./auditEvent.service');
const { RADIOLOGY_TRANSITIONS: TRANSITIONS, ensureWorkflowTransition } = require('./workflowDefinitions.service');

async function transition({ req, request, to, hospitalId, note, patch = {} }) {
  const before = request.status;
  ensureWorkflowTransition('radiology', TRANSITIONS, before, to);

  request.status = to;
  request.workflowHistory = request.workflowHistory || [];
  request.workflowHistory.push({
    from: before,
    to,
    at: operationNow(),
    by: req.user?._id,
    note
  });

  Object.assign(request, patch);

  if (to === 'Approved') {
    request.approvedAt = request.approvedAt || operationNow();
    if (req.user?.radiologyStaffId) request.approvedBy = req.user.radiologyStaffId;
  }

  if (to === 'Scheduled') {
    request.scheduledStart = patch.scheduledStart || request.scheduledStart || operationNow();
  }

  if (to === 'In Progress') {
    request.performedAt = request.performedAt || operationNow();
    if (req.user?.radiologyStaffId) request.performedBy = req.user.radiologyStaffId;
  }

  if (to === 'Result Entered') {
    request.resultEnteredAt = operationNow();
    // Editing verified content re-opens the report for verification. Never leave
    // stale verifier metadata attached to content that has changed.
    if (before === 'Verified') {
      request.verifiedAt = undefined;
      request.verifiedByUserId = undefined;
    }
  }

  if (to === 'Verified') {
    request.verifiedAt = operationNow();
    request.verifiedByUserId = req.user?._id;
  }

  if (to === 'Reported') {
    request.releasedAt = operationNow();
    request.releasedBy = req.user?._id;
    request.reportedAt = request.reportedAt || operationNow();
    if (req.user?.radiologyStaffId) request.reportedBy = req.user.radiologyStaffId;
  }

  await request.save();

  await appendDomainEvent({
    req,
    eventType: to === 'Reported' ? 'radiology.report_released' : 'radiology.status_changed',
    entityType: 'RadiologyRequest',
    entityId: request._id,
    hospitalId,
    patientId: request.patientId,
    encounterId: request.admissionId,
    revision: request.workflowHistory.length,
    beforeSummary: { status: before },
    afterSummary: { status: to },
    comments: note
  });

  return request;
}

module.exports = { transition, TRANSITIONS };