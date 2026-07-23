const LabRequest = require('../models/LabRequest');
const { appendDomainEvent } = require('./auditEvent.service');
const { LAB_TRANSITIONS: TRANSITIONS, ensureWorkflowTransition } = require('./workflowDefinitions.service');

function ensureTransition(from, to) {
  ensureWorkflowTransition('laboratory', TRANSITIONS, from, to);
}

async function transition({ req, request, to, note, hospitalId, patch = {} }) {
  ensureTransition(request.status, to);

  const before = request.status;
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

  if (to === 'Sample Collected') {
    request.sample_collected_at = patch.sample_collected_at || new Date();
    request.collectedByUserId = req.user?._id;
  }

  if (to === 'Received') {
    request.receivedAt = new Date();
    request.receivedBy = req.user?._id;
  }

  if (to === 'Processing') {
    request.processing_started_at = request.processing_started_at || new Date();
  }

  if (to === 'Result Entered') {
    request.resultEnteredAt = new Date();
  }

  if (to === 'Verified') {
    request.verifiedAt = new Date();
    request.verifierUserId = req.user?._id;
  }

  if (to === 'Reported') {
    request.releasedAt = new Date();
    request.releasedBy = req.user?._id;
  }

  if (to === 'Rejected') {
    request.rejection = {
      ...request.rejection,
      ...patch.rejection,
      rejectedAt: new Date(),
      rejectedBy: req.user?._id
    };
  }

  await request.save();

  await appendDomainEvent({
    req,
    eventType: to === 'Reported' ? 'lab.report_released' : 'lab.status_changed',
    entityType: 'LabRequest',
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

module.exports = {
  transition,
  ensureTransition,
  TRANSITIONS
};