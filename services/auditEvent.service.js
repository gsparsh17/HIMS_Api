const crypto = require('crypto');
const DomainEvent = require('../models/DomainEvent');

function eventId() {
  return `evt_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

async function appendDomainEvent({ req, eventType, entityType, entityId, hospitalId, patientId, encounterId, revision = 1, beforeSummary, afterSummary, reasonCode, comments, correlationId, metadata, session }) {
  const payload = {
    eventId: eventId(),
    eventType,
    occurredAt: new Date(),
    hospitalId,
    patientId,
    encounterId,
    actorUserId: req?.user?._id,
    actorRole: req?.user?.role,
    sourceIp: req?.ip,
    userAgent: req?.get?.('user-agent'),
    entityType,
    entityId,
    revision,
    beforeSummary,
    afterSummary,
    reasonCode,
    comments,
    correlationId,
    metadata
  };
  const [record] = await DomainEvent.create([payload], session ? { session } : undefined);
  return record;
}

module.exports = { appendDomainEvent };
