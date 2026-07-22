const IPDConsent = require('../models/IPDConsent');
const IPDAdmission = require('../models/IPDAdmission');
const Hospital = require('../models/Hospital');
const { version, templates } = require('../data/ipdConsentTemplates');
const { generateConsentPdf } = require('../services/consentPdf.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

const findTemplate = (id) => templates.find((template) => template.id === id);
const scopeKey = (body = {}, query = {}) => body.scopeKey || query.scopeKey || (body.relatedOTCaseId || query.relatedOTCaseId ? `ot:${body.relatedOTCaseId || query.relatedOTCaseId}` : body.relatedProcedureId || query.relatedProcedureId ? `procedure:${body.relatedProcedureId || query.relatedProcedureId}` : 'admission');

async function admissionFor(req) {
  const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId: requireHospitalId(req) });
  if (!admission) throw Object.assign(new Error('IPD admission not found'), { statusCode: 404 });
  return admission;
}

exports.listTemplates = async (_req, res) => res.json({ success: true, version, data: templates });

exports.listAdmissionConsents = async (req, res, next) => {
  try {
    const admission = await admissionFor(req);
    const filter = { hospitalId: admission.hospitalId, admissionId: admission._id };
    if (req.query.relatedOTCaseId) filter.relatedOTCaseId = req.query.relatedOTCaseId;
    const records = await IPDConsent.find(filter).sort({ updatedAt: -1 });
    res.json({ success: true, version, data: templates.map((template) => ({ template, consents: records.filter((record) => record.templateId === template.id), consent: records.find((record) => record.templateId === template.id && record.scopeKey === 'admission') || null })) });
  } catch (error) { next(error); }
};

exports.getConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const consent = await IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: scopeKey({}, req.query) });
    res.json({ success: true, data: { template, consent } });
  } catch (error) { next(error); }
};

exports.saveConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const responses = req.body.responses && typeof req.body.responses === 'object' ? req.body.responses : {};
    const requestedStatus = ['Completed', 'Signed'].includes(req.body.status) ? req.body.status : 'Draft';
    if (requestedStatus !== 'Draft') {
      const missing = (template.fields || []).filter((field) => field.required).filter((field) => {
        const value = responses[field.key];
        return value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
      });
      if (missing.length) return res.status(400).json({ error: `Complete required fields: ${missing.map((field) => field.label).join(', ')}` });
    }
    const key = scopeKey(req.body);
    const existing = await IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: key });
    const update = {
      hospitalId: admission.hospitalId, patientId: admission.patientId, templateId: template.id, templateName: template.name,
      templateVersion: template.version, formRevision: Number(existing?.formRevision || 0) + 1, scopeKey: key,
      relatedOTCaseId: req.body.relatedOTCaseId, relatedProcedureId: req.body.relatedProcedureId,
      status: requestedStatus, responses, signatures: Array.isArray(req.body.signatures) ? req.body.signatures : existing?.signatures || [], notes: req.body.notes || '', updatedBy: req.user._id,
      ...(requestedStatus !== 'Draft' ? { completedAt: new Date(), completedBy: req.user._id } : {})
    };
    const consent = await IPDConsent.findOneAndUpdate(
      { hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: key },
      { $set: update, $setOnInsert: { admissionId: admission._id, createdBy: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
    await appendDomainEvent({ req, eventType: requestedStatus === 'Draft' ? 'consent.draft_saved' : 'consent.completed', entityType: 'IPDConsent', entityId: consent._id, hospitalId: admission.hospitalId, patientId: admission.patientId, encounterId: admission._id, revision: consent.formRevision, afterSummary: { templateId: template.id, status: requestedStatus, scopeKey: key } });
    res.json({ success: true, message: requestedStatus === 'Draft' ? 'Consent draft saved' : 'Consent completed', data: consent });
  } catch (error) { next(error); }
};

exports.printConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const consent = await IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: scopeKey({}, req.query) });
    if (!consent) return res.status(404).json({ error: 'Consent form has not been saved' });
    await admission.populate('patientId wardId bedId');
    const hospital = await Hospital.findById(admission.hospitalId);
    generateConsentPdf({ consent, template, admission, hospital, res });
  } catch (error) { if (!res.headersSent) next(error); }
};
