const crypto = require('crypto');
const AbdmAccessAudit = require('../models/AbdmAccessAudit');
const { assertUserHospital } = require('../utils/hospitalScope');

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function recordAccess(req, data) {
  return AbdmAccessAudit.create({
    hospitalId: assertUserHospital(req.user),
    actorUserId: req.user?._id,
    patientId: data.patientId,
    importedRecordId: data.importedRecordId,
    consentId: data.consentId,
    action: data.action,
    purpose: data.purpose || 'TREATMENT',
    sourceIpHash: digest(req.ip),
    userAgentHash: digest(req.headers['user-agent']),
    metadata: data.metadata
  });
}

module.exports = { recordAccess };
