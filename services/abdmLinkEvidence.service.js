const crypto = require('crypto');
const AbdmLinkAuthorizationEvidence = require('../models/AbdmLinkAuthorizationEvidence');

function contextsHash(contexts = []) {
  const normalized = contexts.map((item) => ({
    id: String(item._id || item.id || ''),
    referenceNumber: String(item.referenceNumber || ''),
    hiType: String(item.hiType || '')
  })).sort((a, b) => a.referenceNumber.localeCompare(b.referenceNumber));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function createHipEvidence({ hospitalId, patientId, userId, contexts }) {
  return AbdmLinkAuthorizationEvidence.create({
    evidenceId: `LINK-${crypto.randomUUID()}`,
    hospitalId,
    patientId,
    initiatedBy: userId,
    mode: 'HIP_INITIATED',
    selectedCareContextIds: contexts.map((item) => item._id),
    selectedReferenceNumbers: contexts.map((item) => item.referenceNumber),
    selectedContextsHash: contextsHash(contexts),
    status: 'CREATED'
  });
}

async function createUserEvidence({ hospitalId, patientId, contexts, transactionId, requestId, authentication }) {
  return AbdmLinkAuthorizationEvidence.create({
    evidenceId: `LINK-${crypto.randomUUID()}`,
    hospitalId,
    patientId,
    mode: 'USER_INITIATED',
    selectedCareContextIds: contexts.map((item) => item._id),
    selectedReferenceNumbers: contexts.map((item) => item.referenceNumber),
    selectedContextsHash: contextsHash(contexts),
    transactionId,
    authentication,
    linkTokenCallbackRequestId: requestId,
    status: 'CREATED'
  });
}

async function assertEvidenceContextsUnchanged(evidence, contexts) {
  const currentHash = contextsHash(contexts);
  if (currentHash !== evidence.selectedContextsHash) {
    evidence.status = 'CONTEXT_CHANGED';
    evidence.failure = { code: 'CARE_CONTEXT_SELECTION_CHANGED', message: 'Selected care-context set changed after linking was initiated', at: new Date() };
    await evidence.save();
    const error = new Error('Care-context selection changed after ABDM linking was initiated');
    error.statusCode = 409;
    error.code = 'ABDM_LINK_CONTEXT_CHANGED';
    throw error;
  }
  return true;
}

module.exports = {
  contextsHash,
  createHipEvidence,
  createUserEvidence,
  assertEvidenceContextsUnchanged
};
