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
    at: new Date(),
    by: req.user?._id,
    note
  });

  Object.assign(request, patch);

  if (to === 'Scheduled') {
    request.scheduledStart = patch.scheduledStart || request.scheduledStart || new Date();
  }

  if (to === 'In Progress') {
    request.performedAt = request.performedAt || new Date();
  }

  if (to === 'Result Entered') {
    request.resultEnteredAt = new Date();
  }

  if (to === 'Verified') {
    request.verifiedAt = new Date();
    request.verifiedByUserId = req.user?._id;
  }

  if (to === 'Reported') {
    request.releasedAt = new Date();
    request.releasedBy = req.user?._id;
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