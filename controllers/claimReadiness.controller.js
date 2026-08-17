const ClaimCase = require('../models/ClaimCase');
const ClaimEvidence = require('../models/ClaimEvidence');
const SchemeRuleProfile = require('../models/SchemeRuleProfile');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const claimReadiness = require('../services/claimReadiness.service');

function fail(res, error) {
  return res.status(error.statusCode || 400).json({ success: false, error: error.message, readiness: error.readiness });
}

async function claimForHospital(hospitalId, id) {
  const claim = await ClaimCase.findOne({ _id: id, hospitalId });
  if (!claim) { const error = new Error('Claim not found'); error.statusCode = 404; throw error; }
  return claim;
}

exports.getReadiness = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await claimReadiness.evaluate({ hospitalId, claimId: req.params.id });
    return res.json({ success: true, data });
  } catch (error) { return fail(res, error); }
};

exports.overrideReadiness = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const claim = await claimForHospital(hospitalId, req.params.id);
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 8) return res.status(400).json({ success: false, error: 'Override reason must be at least 8 characters.' });
    claim.readiness = claim.readiness || {};
    claim.readiness.override = { active: true, reason, by: req.user._id, at: new Date() };
    claim.readiness.status = 'overridden';
    claim.updatedBy = req.user._id;
    claim.revision += 1;
    await claim.save();
    await appendDomainEvent({
      req,
      eventType: 'billing.claim_readiness_overridden',
      entityType: 'ClaimCase',
      entityId: claim._id,
      hospitalId,
      patientId: claim.patientId,
      encounterId: claim.admissionId || claim.appointmentId,
      revision: claim.revision,
      afterSummary: { reason }
    });
    return res.json({ success: true, data: claim.readiness });
  } catch (error) { return fail(res, error); }
};

exports.clearReadinessOverride = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const claim = await claimForHospital(hospitalId, req.params.id);
    claim.readiness = claim.readiness || {};
    claim.readiness.override = { active: false };
    claim.readiness.status = 'not_evaluated';
    claim.updatedBy = req.user._id;
    claim.revision += 1;
    await claim.save();
    await appendDomainEvent({
      req,
      eventType: 'billing.claim_readiness_override_cleared',
      entityType: 'ClaimCase',
      entityId: claim._id,
      hospitalId,
      patientId: claim.patientId,
      encounterId: claim.admissionId || claim.appointmentId,
      revision: claim.revision
    });
    return res.json({ success: true, data: claim.readiness });
  } catch (error) { return fail(res, error); }
};

exports.listEvidence = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    await claimForHospital(hospitalId, req.params.id);
    const data = await ClaimEvidence.find({ hospitalId, claimId: req.params.id, status: { $ne: 'entered_in_error' } }).sort({ evidenceStage: 1, capturedAt: 1, createdAt: 1 });
    return res.json({ success: true, data });
  } catch (error) { return fail(res, error); }
};

exports.addEvidence = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const claim = await claimForHospital(hospitalId, req.params.id);
    const sourceModel = String(req.body.sourceModel || '').trim();
    if (!sourceModel) return res.status(400).json({ success: false, error: 'sourceModel is required.' });
    if (!req.body.sourceId && !req.body.documentId && !req.body.fileUrl) return res.status(400).json({ success: false, error: 'Link a sourceId, documentId or fileUrl.' });
    const data = await ClaimEvidence.create({
      hospitalId,
      claimId: claim._id,
      patientId: claim.patientId,
      encounterType: claim.encounterType,
      admissionId: claim.admissionId,
      appointmentId: claim.appointmentId,
      procedureId: req.body.procedureId,
      sourceModel,
      sourceId: req.body.sourceId,
      documentId: req.body.documentId,
      fileUrl: req.body.fileUrl,
      evidenceType: req.body.evidenceType || 'OTHER',
      evidenceStage: req.body.evidenceStage || 'supporting',
      capturedAt: req.body.capturedAt,
      bodySite: req.body.bodySite,
      laterality: req.body.laterality || '',
      caption: req.body.caption,
      patientIdentityVisible: Boolean(req.body.patientIdentityVisible),
      clinicalSiteVisible: Boolean(req.body.clinicalSiteVisible),
      patientDateVisible: Boolean(req.body.patientDateVisible),
      metadata: req.body.metadata || {},
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return fail(res, error); }
};

exports.updateEvidence = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    await claimForHospital(hospitalId, req.params.id);
    const evidence = await ClaimEvidence.findOne({ _id: req.params.evidenceId, hospitalId, claimId: req.params.id });
    if (!evidence) return res.status(404).json({ success: false, error: 'Claim evidence not found' });
    const allowed = ['procedureId', 'sourceModel', 'sourceId', 'documentId', 'fileUrl', 'evidenceType', 'evidenceStage', 'capturedAt', 'bodySite', 'laterality', 'caption', 'patientIdentityVisible', 'clinicalSiteVisible', 'patientDateVisible', 'metadata', 'status'];
    for (const key of allowed) if (req.body[key] !== undefined) evidence[key] = req.body[key];
    evidence.updatedBy = req.user._id;
    await evidence.save();
    return res.json({ success: true, data: evidence });
  } catch (error) { return fail(res, error); }
};

exports.listRuleProfiles = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (req.query.schemeType) filter.schemeType = String(req.query.schemeType).toLowerCase();
    const data = await SchemeRuleProfile.find(filter).sort({ schemeType: 1, effectiveFrom: -1 });
    return res.json({ success: true, data });
  } catch (error) { return fail(res, error); }
};

exports.upsertRuleProfile = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const schemeType = String(req.body.schemeType || '').trim().toLowerCase();
    const version = String(req.body.version || '').trim();
    const scopeLevel = String(req.body.scopeLevel || 'hospital').trim().toLowerCase();
    const jurisdiction = String(req.body.jurisdiction || (scopeLevel === 'hospital' ? 'hospital' : 'unspecified')).trim();
    if (!schemeType || !version || !req.body.profileName) return res.status(400).json({ success: false, error: 'schemeType, profileName and version are required.' });
    const data = await SchemeRuleProfile.findOneAndUpdate(
      { hospitalId, schemeType, scopeLevel, jurisdiction, version },
      {
        $set: {
          profileName: req.body.profileName,
          sourceReference: req.body.sourceReference,
          effectiveFrom: req.body.effectiveFrom || new Date(),
          effectiveTo: req.body.effectiveTo || null,
          active: req.body.active !== false,
          rules: req.body.rules || {},
          packageRules: req.body.packageRules || [],
          updatedBy: req.user._id
        },
        $setOnInsert: { hospitalId, schemeType, scopeLevel, jurisdiction, version, createdBy: req.user._id }
      },
      { new: true, upsert: true, runValidators: true }
    );
    return res.json({ success: true, data });
  } catch (error) { return fail(res, error); }
};
