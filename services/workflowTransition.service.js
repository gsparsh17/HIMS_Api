const { appendDomainEvent } = require('./auditEvent.service');

function transitionError(message, statusCode = 409, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function transitionDocument({ document, action, definitions, req, hospitalId, patientId, encounterId, reasonCode, comments, session, extraUpdate = {} }) {
  const definition = definitions[action];
  if (!definition) throw transitionError(`Unknown transition action: ${action}`, 400);
  const current = document.status;
  if (!definition.from.includes(current)) {
    throw transitionError(`Cannot ${action} while status is ${current}`, 409, { current, allowed: definition.from });
  }
  if (definition.guard) {
    const guardResult = await definition.guard(document, req);
    if (guardResult !== true) {
      const message = typeof guardResult === 'string' ? guardResult : 'Transition prerequisites are not complete';
      throw transitionError(message, 409);
    }
  }

  const before = { status: document.status, version: document.version || 0 };
  document.status = definition.to;
  document.version = Number(document.version || 0) + 1;
  Object.assign(document, typeof definition.update === 'function' ? definition.update(document, req) : definition.update || {}, extraUpdate);
  await document.save({ session });
  await appendDomainEvent({
    req,
    eventType: definition.eventType || `${document.constructor.modelName.toLowerCase()}.${action}`,
    entityType: document.constructor.modelName,
    entityId: document._id,
    hospitalId,
    patientId,
    encounterId,
    revision: document.version,
    beforeSummary: before,
    afterSummary: { status: document.status, version: document.version },
    reasonCode,
    comments,
    session
  });
  return document;
}

module.exports = { transitionDocument, transitionError };
