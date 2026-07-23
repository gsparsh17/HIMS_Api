const OTRequest = require('../models/OTRequest');
const OTClinicalForm = require('../models/OTClinicalForm');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
const OTSurgicalSafetyChecklist = require('../models/OTSurgicalSafetyChecklist');
const OTPreAnaesthesiaAssessment = require('../models/OTPreAnaesthesiaAssessment');
const OTAnesthesiaRecord = require('../models/OTAnesthesiaRecord');
const OTOperativeNote = require('../models/OTOperativeNote');
const OTRecoveryRecord = require('../models/OTRecoveryRecord');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const DocumentSignature = require('../models/DocumentSignature');
const EncounterDocument = require('../models/EncounterDocument');
const RenderedDocument = require('../models/RenderedDocument');
const fs = require('fs');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { getTemplate, listTemplates } = require('../config/otSurgeryFormTemplates');
const { renderOtFormPdf, renderOtPacketPdf, sha256, writeRenderedPdf } = require('../services/otFormPdf.service');

const nativeModels = {
  OTReadinessChecklist,
  OTSurgicalSafetyChecklist,
  OTPreAnaesthesiaAssessment,
  OTAnesthesiaRecord,
  OTOperativeNote,
  OTRecoveryRecord,
  OTCaseInventoryUsage,
};

function publicRecord(record) {
  if (!record) return null;
  return typeof record.toObject === 'function' ? record.toObject() : record;
}

async function findCase(req, caseId) {
  const hospitalId = requireHospitalId(req);
  const otCase = await OTRequest.findOne({ _id: caseId, hospitalId })
    .populate('patientId', 'first_name last_name name patient_id uhid age gender date_of_birth')
    .populate('doctorId primarySurgeonId assistantSurgeonId anesthetistId', 'first_name last_name name specialization registration_number')
    .populate('admissionId', 'admissionNumber shipNumber status admissionDate dischargeDate');
  if (!otCase) {
    const error = new Error('OT case not found');
    error.statusCode = 404;
    throw error;
  }
  return otCase;
}

function isEmpty(value, type) {
  if (type === 'checkbox') return value !== true;
  if (type === 'checklist' || type === 'table') return !Array.isArray(value) || value.length === 0;
  return value === undefined || value === null || String(value).trim() === '';
}

function requiredFieldErrors(template, formData = {}) {
  const missing = [];
  (template.sections || []).forEach((section) => {
    (section.fields || []).forEach((field) => {
      if (field.required && isEmpty(formData[field.key], field.type)) missing.push(field.label);
    });
  });
  return missing;
}

function statusFromNative(template, record) {
  if (!record) return 'Not Started';
  if (template.id === 'ot_readiness') {
    if (['Ready', 'Ready With Bypass'].includes(record.overallStatus)) return 'Completed/Unsigned';
    return record.items?.some((item) => item.status !== 'Pending') ? 'Draft' : 'Not Started';
  }
  if (template.id === 'surgical_safety_checklist') {
    if (record.finalizedAt || [record.signIn?.status, record.timeOut?.status, record.signOut?.status].every((value) => ['Completed', 'Bypassed'].includes(value))) return 'Completed/Unsigned';
    const touched = [record.signIn, record.timeOut, record.signOut].some((section) => section?.items?.some((item) => item.response));
    return touched ? 'Draft' : 'Not Started';
  }
  const value = record.status || record.overallStatus;
  if (['Signed'].includes(value)) return 'Final/Signed';
  if (['Completed', 'Ready For Transfer', 'Transferred', 'Reconciled'].includes(value)) return 'Completed/Unsigned';
  return value ? 'Draft' : 'Not Started';
}

function statusFromStructured(record) {
  if (!record) return 'Not Started';
  if (record.status === 'Signed') return 'Final/Signed';
  if (record.status === 'Completed') return 'Completed/Unsigned';
  return 'Draft';
}

async function loadNativeRecords(hospitalId, caseId, templates) {
  const pairs = await Promise.all(templates.filter((template) => template.implementation === 'native').map(async (template) => {
    const Model = nativeModels[template.sourceModel];
    const record = Model ? await Model.findOne({ hospitalId, caseId }).lean() : null;
    return [template.id, record];
  }));
  return new Map(pairs);
}


function activeSignatureRoles(signatures = []) {
  return new Set(signatures.filter((signature) => signature.status === 'signed').map((signature) => String(signature.signatoryRole || signature.metadata?.signatoryRole || signature.signerRole || '').toLowerCase()));
}

function formSignatureState(template, signatures = []) {
  const active = signatures.filter((signature) => signature.status === 'signed');
  if (!active.length) return { complete: false, signatures: [] };
  const requiredRoles = (template.signatureRoles || []).map((role) => String(role).toLowerCase());
  const roles = activeSignatureRoles(active);
  return {
    complete: requiredRoles.length ? requiredRoles.every((role) => roles.has(role)) : true,
    signatures: active.map((signature) => ({
      id: String(signature._id), signerName: signature.signerName, signerRole: signature.signerRole,
      signatoryRole: signature.signatoryRole || signature.metadata?.signatoryRole,
      signerDesignation: signature.signerDesignation, signedAt: signature.signedAt,
      verificationCode: signature.verificationCode,
    })),
    missingRoles: requiredRoles.filter((role) => !roles.has(role)),
  };
}

async function loadFormRecord(hospitalId, otCase, template) {
  if (template.implementation === 'native') {
    const Model = nativeModels[template.sourceModel];
    return Model ? Model.findOne({ hospitalId, caseId: otCase._id }) : null;
  }
  return OTClinicalForm.findOne({ hospitalId, caseId: otCase._id, templateId: template.id });
}

async function registerEncounterDocument(req, otCase, template, record) {
  if (!record?._id) return null;
  const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
  return EncounterDocument.findOneAndUpdate(
    { hospitalId: otCase.hospitalId, sourceModel, sourceId: record._id, sourceRevision: Number(record.version || 1) },
    { $set: {
      hospitalId: otCase.hospitalId, patientId: otCase.patientId?._id || otCase.patientId,
      admissionId: otCase.admissionId?._id || otCase.admissionId, encounterType: 'IPD',
      category: template.category, documentType: template.id, title: template.title,
      sourceModel, sourceId: record._id, sourceRevision: Number(record.version || 1), rendererKey: template.rendererId || 'ot-structured-form',
      status: record.status === 'Signed' ? 'Final/Signed' : record.status === 'Completed' ? 'Completed/Unsigned' : 'Draft',
      relatedCaseId: otCase._id, relatedCaseType: 'OTRequest', documentDate: record.completedAt || record.updatedAt || new Date(),
      authorUserId: req.user?._id, authorName: req.user?.name, templateId: template.id, templateVersion: String(template.version),
      required: Boolean(template.required), metadata: { pageCount: template.pageCount || 1, sourceReference: template.sourceReference }, visibility: 'clinical',
    } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

exports.listTemplates = async (req, res, next) => {
  try {
    requireHospitalId(req);
    res.json({ success: true, data: listTemplates({ category: req.query.category, stage: req.query.stage }) });
  } catch (error) { next(error); }
};

exports.listCaseForms = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const templates = listTemplates({ category: req.query.category, stage: req.query.stage });
    const [structuredRecords, nativeRecords, signatures] = await Promise.all([
      OTClinicalForm.find({ hospitalId, caseId: otCase._id }).sort({ updatedAt: -1 }).lean(),
      loadNativeRecords(hospitalId, otCase._id, templates),
      DocumentSignature.find({ hospitalId, admissionId: otCase.admissionId?._id || otCase.admissionId, status: 'signed' }).sort({ signedAt: -1 }).lean(),
    ]);
    const structuredMap = new Map(structuredRecords.map((record) => [record.templateId, record]));
    const signatureMap = new Map();
    signatures.forEach((signature) => {
      const key = `${signature.sourceModel}:${signature.sourceId}`;
      const list = signatureMap.get(key) || [];
      list.push(signature);
      signatureMap.set(key, list);
    });
    const forms = templates.map((template) => {
      const record = template.implementation === 'native' ? nativeRecords.get(template.id) : structuredMap.get(template.id);
      const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
      const sourceId = record?._id ? String(record._id) : null;
      const signatureState = formSignatureState(template, sourceId ? (signatureMap.get(`${sourceModel}:${sourceId}`) || []) : []);
      const underlyingStatus = template.implementation === 'native' ? statusFromNative(template, record) : statusFromStructured(record);
      const status = signatureState.complete ? 'Final/Signed' : underlyingStatus;
      return {
        ...template,
        status,
        recordId: record?._id ? String(record._id) : null,
        sourceModel,
        sourceId,
        sourceRevision: Number(record?.version || 1),
        updatedAt: record?.updatedAt,
        completedAt: record?.completedAt || record?.signedAt || record?.finalizedAt,
        signatures: signatureState.signatures,
        missingSignatureRoles: signatureState.missingRoles,
        signature: signatureState.signatures[0],
        content: req.query.includeContent === 'true' ? publicRecord(record) : undefined,
      };
    });
    const counts = forms.reduce((acc, form) => {
      acc[form.status] = (acc[form.status] || 0) + 1;
      return acc;
    }, {});
    res.json({
      success: true,
      data: {
        case: {
          id: String(otCase._id), requestNumber: otCase.requestNumber, procedureName: otCase.procedureName,
          status: otCase.status, patient: otCase.patientId, patientId: otCase.patientId, doctorId: otCase.doctorId, primarySurgeonId: otCase.primarySurgeonId, admission: otCase.admissionId,
        },
        counts,
        forms,
      },
    });
  } catch (error) { next(error); }
};

exports.getCaseForm = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const template = getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Surgery form template not found' });
    let record = null;
    if (template.implementation === 'native') {
      const Model = nativeModels[template.sourceModel];
      record = Model ? await Model.findOne({ hospitalId, caseId: otCase._id }).lean() : null;
    } else {
      record = await OTClinicalForm.findOne({ hospitalId, caseId: otCase._id, templateId: template.id }).lean();
    }
    const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
    const signatures = record?._id ? await DocumentSignature.find({ hospitalId, sourceModel, sourceId: record._id, status: 'signed' }).sort({ signedAt: 1 }).lean() : [];
    const signatureState = formSignatureState(template, signatures);
    res.json({ success: true, data: { template, record, signatures: signatureState.signatures, missingSignatureRoles: signatureState.missingRoles, signature: signatureState.signatures[0], status: signatureState.complete ? 'Final/Signed' : (template.implementation === 'native' ? statusFromNative(template, record) : statusFromStructured(record)) } });
  } catch (error) { next(error); }
};

exports.saveCaseForm = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const template = getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Surgery form template not found' });
    if (template.implementation !== 'structured') {
      return res.status(409).json({ error: 'This form is managed by its dedicated OT module', nativeTab: template.nativeTab });
    }

    const requestedStatus = ['Draft', 'Completed', 'Amended'].includes(req.body.status) ? req.body.status : 'Draft';
    const formData = req.body.formData && typeof req.body.formData === 'object' ? req.body.formData : {};
    if (requestedStatus === 'Completed') {
      const missing = requiredFieldErrors(template, formData);
      if (missing.length) return res.status(400).json({ error: 'Complete all required fields before finalising the form', missingFields: missing });
    }

    const current = await OTClinicalForm.findOne({ hospitalId, caseId: otCase._id, templateId: template.id });
    const status = current?.status === 'Signed' ? 'Amended' : requestedStatus;
    const update = {
      hospitalId,
      caseId: otCase._id,
      admissionId: otCase.admissionId?._id || otCase.admissionId,
      patientId: otCase.patientId?._id || otCase.patientId,
      templateId: template.id,
      templateVersion: template.version,
      title: template.title,
      category: template.category,
      stage: template.stage,
      required: template.required,
      formData,
      status,
      lastEditedBy: req.user._id,
      amendmentReason: status === 'Amended' ? req.body.amendmentReason : undefined,
    };
    if (requestedStatus === 'Completed') {
      update.completedBy = req.user._id;
      update.completedAt = new Date();
    }
    const record = await OTClinicalForm.findOneAndUpdate(
      { hospitalId, caseId: otCase._id, templateId: template.id },
      { $set: update, $inc: { version: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    await registerEncounterDocument(req, otCase, template, record);

    await appendDomainEvent({
      req,
      entityType: 'OTClinicalForm', entityId: record._id,
      eventType: current ? 'ot.form.updated' : 'ot.form.created',
      hospitalId,
      patientId: record.patientId,
      encounterId: record.admissionId,
      metadata: { caseId: String(otCase._id), templateId: template.id, status: record.status, version: record.version },
    }).catch(() => null);

    res.json({ success: true, message: `${template.title} saved`, data: record });
  } catch (error) { next(error); }
};

exports.resetCaseForm = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    await findCase(req, req.params.id);
    const template = getTemplate(req.params.templateId);
    if (!template || template.implementation !== 'structured') return res.status(404).json({ error: 'Structured surgery form not found' });
    const record = await OTClinicalForm.findOne({ hospitalId, caseId: req.params.id, templateId: template.id });
    if (!record) return res.status(404).json({ error: 'Surgery form record not found' });
    if (record.status === 'Signed') return res.status(409).json({ error: 'A signed form cannot be reset; create an amendment instead' });
    await record.deleteOne();
    res.json({ success: true, message: `${template.title} reset` });
  } catch (error) { next(error); }
};


exports.previewCaseFormPdf = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const template = getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Surgery form template not found' });
    const record = await loadFormRecord(hospitalId, otCase, template);
    if (!record) return res.status(404).json({ error: 'Surgery form has not been started' });
    const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
    const signatures = await DocumentSignature.find({ hospitalId, sourceModel, sourceId: record._id, status: 'signed' }).sort({ signedAt: 1 }).lean();
    const pdf = await renderOtFormPdf({ template, record, otCase, signatures });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="${template.id}-${otCase.requestNumber || otCase._id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (error) { next(error); }
};

exports.finalizeCaseFormPdf = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const template = getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Surgery form template not found' });
    const record = await loadFormRecord(hospitalId, otCase, template);
    if (!record) return res.status(404).json({ error: 'Surgery form has not been started' });
    const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
    const signatures = await DocumentSignature.find({ hospitalId, sourceModel, sourceId: record._id, status: 'signed' }).sort({ signedAt: 1 }).lean();
    const signatureState = formSignatureState(template, signatures);
    const pdf = await renderOtFormPdf({ template, record, otCase, signatures });
    const checksum = sha256(pdf);
    const revision = Number(record.version || 1);
    await RenderedDocument.updateMany({ hospitalId, sourceModel, sourceId: record._id, status: { $in: ['final', 'preview'] } }, { $set: { status: 'superseded' } });
    const storagePath = writeRenderedPdf(pdf, { hospitalId, caseId: otCase._id, templateId: template.id, revision });
    const rendered = await RenderedDocument.create({
      hospitalId, patientId: otCase.patientId?._id || otCase.patientId, admissionId: otCase.admissionId?._id || otCase.admissionId,
      relatedCaseId: otCase._id, documentType: template.id, title: template.title, sourceModel, sourceId: record._id,
      sourceRevision: revision, templateId: template.id, templateVersion: template.version, storagePath,
      sizeBytes: pdf.length, sha256: checksum, pageCount: template.pageCount || 1,
      signatureIds: signatures.map((signature) => signature._id), verificationCodes: signatures.map((signature) => signature.verificationCode),
      status: signatureState.complete ? 'final' : 'preview', generatedBy: req.user._id,
      metadata: { missingSignatureRoles: signatureState.missingRoles, sourceReference: template.sourceReference },
    });
    if (signatureState.complete && record.status !== 'Signed') {
      record.status = 'Signed'; record.signedAt = new Date(); await record.save();
    }
    const encounterDocument = await registerEncounterDocument(req, otCase, template, record);
    if (encounterDocument) {
      encounterDocument.status = signatureState.complete ? 'Final/Signed' : (record.status === 'Completed' ? 'Completed/Unsigned' : 'Draft');
      encounterDocument.fileUrl = `/api/ot/cases/${otCase._id}/forms/${template.id}/rendered/${rendered._id}`;
      encounterDocument.mimeType = 'application/pdf';
      encounterDocument.metadata = { ...(encounterDocument.metadata || {}), renderedDocumentId: String(rendered._id), checksum, missingSignatureRoles: signatureState.missingRoles };
      await encounterDocument.save();
    }
    res.setHeader('X-Rendered-Document-Id', String(rendered._id));
    res.setHeader('X-Document-Status', rendered.status);
    res.setHeader('X-Missing-Signature-Roles', (signatureState.missingRoles || []).join(','));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${template.id}-${otCase.requestNumber || otCase._id}-signed.pdf"`);
    res.send(pdf);
  } catch (error) { next(error); }
};

exports.streamRenderedCaseForm = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    await findCase(req, req.params.id);
    const rendered = await RenderedDocument.findOne({ _id: req.params.renderedId, hospitalId, relatedCaseId: req.params.id });
    if (!rendered || !fs.existsSync(rendered.storagePath)) return res.status(404).json({ error: 'Rendered document not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="${rendered.templateId}-r${rendered.sourceRevision}.pdf"`);
    res.setHeader('ETag', rendered.sha256);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(rendered.storagePath).pipe(res);
  } catch (error) { next(error); }
};

exports.casePacketPdf = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await findCase(req, req.params.id);
    const templates = listTemplates().filter((template) => !req.query.requiredOnly || template.required);
    const [records, nativeRecords] = await Promise.all([
      OTClinicalForm.find({ hospitalId, caseId: otCase._id }).lean(),
      loadNativeRecords(hospitalId, otCase._id, templates),
    ]);
    const recordMap = new Map(records.map((record) => [record.templateId, record]));
    const formSources = templates.map((template) => {
      const record = template.implementation === 'native' ? nativeRecords.get(template.id) : recordMap.get(template.id);
      const sourceModel = template.implementation === 'native' ? template.sourceModel : 'OTClinicalForm';
      return { template, record, sourceModel };
    }).filter(({ record }) => Boolean(record));
    const signatureConditions = formSources.map(({ sourceModel, record }) => ({ sourceModel, sourceId: record._id }));
    const signatures = signatureConditions.length
      ? await DocumentSignature.find({ hospitalId, status: 'signed', $or: signatureConditions }).sort({ signedAt: 1 }).lean()
      : [];
    const signatureMap = new Map();
    signatures.forEach((signature) => {
      const key = `${signature.sourceModel}:${signature.sourceId}`;
      const list = signatureMap.get(key) || [];
      list.push(signature);
      signatureMap.set(key, list);
    });
    const forms = formSources.map(({ template, record, sourceModel }) => ({
      template,
      record,
      signatures: signatureMap.get(`${sourceModel}:${record._id}`) || [],
      normalizedStatus: template.implementation === 'native' ? statusFromNative(template, record) : statusFromStructured(record),
    })).filter(({ record, template, normalizedStatus }) => record && (
      req.query.includeDrafts === 'true'
      || ['Completed/Unsigned', 'Final/Signed'].includes(normalizedStatus)
      || !template.required
    ));
    if (!forms.length) return res.status(404).json({ error: 'No OT forms are available for the packet' });
    const pdf = await renderOtPacketPdf({ forms, otCase, hospital: await require('../models/Hospital').findById(hospitalId).lean() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="OT-Packet-${otCase.requestNumber || otCase._id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (error) { next(error); }
};
