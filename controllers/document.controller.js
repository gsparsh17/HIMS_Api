const DocumentSignature = require('../models/DocumentSignature');
const EncounterDocument = require('../models/EncounterDocument');
const { requireHospitalId } = require('../services/tenantScope.service');
const { signDocument } = require('../services/documentSigning.service');
const patientFileManifest = require('../services/patientFileManifest.service');
const RenderedDocument = require('../models/RenderedDocument');
const fs = require('fs');
const { renderPatientFilePdf, writePatientBundle, sha256 } = require('../services/patientFilePdf.service');

exports.sign = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const signature = await signDocument({
      req,
      hospitalId,
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      encounterDocumentId: req.body.encounterDocumentId,
      documentType: req.body.documentType,
      sourceModel: req.body.sourceModel,
      sourceId: req.body.sourceId,
      sourceRevision: Number(req.body.sourceRevision || 1),
      sourceSnapshot: req.body.sourceSnapshot,
      templateId: req.body.templateId,
      templateVersion: req.body.templateVersion,
      placements: req.body.placements,
      metadata: req.body.metadata,
      signatoryRole: req.body.signatoryRole
    });
    res.status(201).json({ success: true, message: 'Document signed', data: signature });
  } catch (error) { next(error); }
};

exports.listSignatures = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (req.query.sourceModel) filter.sourceModel = req.query.sourceModel;
    if (req.query.sourceId) filter.sourceId = req.query.sourceId;
    if (req.query.admissionId) filter.admissionId = req.query.admissionId;
    const signatures = await DocumentSignature.find(filter).sort({ signedAt: -1 }).populate('signerUserId', 'name role');
    res.json({ success: true, data: signatures });
  } catch (error) { next(error); }
};

exports.verify = async (req, res, next) => {
  try {
    const signature = await DocumentSignature.findOne({ verificationCode: String(req.params.code || '').toUpperCase() })
      .select('documentType sourceModel sourceRevision signerName signerRole signatoryRole signerDesignation signerRegistrationNumber signedAt status verificationCode signatureHash');
    if (!signature) return res.status(404).json({ success: false, error: 'Verification code not found' });
    res.json({
      success: true,
      data: {
        documentType: signature.documentType,
        sourceModel: signature.sourceModel,
        sourceRevision: signature.sourceRevision,
        signerName: signature.signerName,
        signerRole: signature.signerRole,
        signatoryRole: signature.signatoryRole,
        signerDesignation: signature.signerDesignation,
        signerRegistrationNumber: signature.signerRegistrationNumber,
        signedAt: signature.signedAt,
        status: signature.status,
        verificationCode: signature.verificationCode,
        integrity: signature.status === 'signed' ? 'valid' : signature.status
      }
    });
  } catch (error) { next(error); }
};

exports.revoke = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const signature = await DocumentSignature.findOne({ _id: req.params.id, hospitalId });
    if (!signature) return res.status(404).json({ error: 'Signed document not found' });
    signature.status = 'revoked';
    signature.revokedAt = new Date();
    signature.revokedBy = req.user._id;
    signature.revokeReason = req.body.reason;
    await signature.save();
    if (signature.encounterDocumentId) {
      await EncounterDocument.findByIdAndUpdate(signature.encounterDocumentId, { $set: { status: 'Completed/Unsigned' } });
    }
    res.json({ success: true, message: 'Signature revoked', data: signature });
  } catch (error) { next(error); }
};

exports.getManifest = async (req, res, next) => {
  try {
    const manifest = await patientFileManifest.buildManifest(req, req.params.admissionId, req.query);
    res.json({ success: true, data: manifest });
  } catch (error) { next(error); }
};

exports.getCompleteness = async (req, res, next) => {
  try {
    const manifest = await patientFileManifest.buildManifest(req, req.params.admissionId, req.query);
    const required = manifest.documents.filter((document) => document.required);
    const missing = required.filter((document) => !['Completed/Unsigned', 'Final/Signed'].includes(document.status));
    res.json({ success: true, data: { total: manifest.documents.length, required: required.length, missing: missing.length, signed: manifest.documents.filter((document) => document.status === 'Final/Signed').length, missingDocuments: missing } });
  } catch (error) { next(error); }
};

exports.getBundlePlan = async (req, res, next) => {
  try {
    const manifest = await patientFileManifest.buildManifest(req, req.params.admissionId, req.query);
    const packetType = req.query.packetType || 'clinical';
    const categories = patientFileManifest.packetCategories(packetType);
    const documents = manifest.documents.filter((document) => categories.includes(document.category) && (req.query.includeDrafts === 'true' || ['Completed/Unsigned', 'Final/Signed'].includes(document.status)));
    res.json({ success: true, data: { ...manifest, packetType, documents, generatedAt: new Date().toISOString() } });
  } catch (error) { next(error); }
};


function selectedBundleDocuments(manifest, body = {}, query = {}) {
  const packetType = body.packetType || query.packetType || 'clinical';
  const categories = patientFileManifest.packetCategories(packetType);
  const selectedKeys = new Set(body.documentKeys || []);
  const includeDrafts = body.includeDrafts === true || query.includeDrafts === 'true';
  const documents = manifest.documents.filter((document) => {
    if (!categories.includes(document.category)) return false;
    if (selectedKeys.size && !selectedKeys.has(document.key)) return false;
    return includeDrafts || ['Completed/Unsigned', 'Final/Signed'].includes(document.status);
  });
  return { packetType, documents };
}

exports.previewPatientFileBundle = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const manifest = await patientFileManifest.buildManifest(req, req.params.admissionId, { includeContent: true });
    const { packetType, documents } = selectedBundleDocuments(manifest, req.body, req.query);
    if (!documents.length) return res.status(400).json({ error: 'No documents selected for the patient file bundle' });
    const packetSignatures = await DocumentSignature.find({ hospitalId, admissionId: req.params.admissionId, documentType: `${packetType}_patient_file`, status: 'signed' }).sort({ signedAt: 1 }).lean();
    const pdf = await renderPatientFilePdf({ manifest, documents, packetType, hospitalId, signatures: packetSignatures });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${packetType}-patient-file-${req.params.admissionId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  } catch (error) { next(error); }
};

exports.finalizePatientFileBundle = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const manifest = await patientFileManifest.buildManifest(req, req.params.admissionId, { includeContent: true });
    const { packetType, documents } = selectedBundleDocuments(manifest, req.body, req.query);
    if (!documents.length) return res.status(400).json({ error: 'No documents selected for the patient file bundle' });
    const sourceModel = 'PatientFileBundle';
    const sourceId = manifest.admission.id;
    const previous = await RenderedDocument.find({ hospitalId, sourceModel, sourceId, documentType: `${packetType}_patient_file` }).sort({ sourceRevision: -1 }).limit(1).lean();
    const revision = Number(previous[0]?.sourceRevision || 0) + 1;
    await RenderedDocument.updateMany({ hospitalId, sourceModel, sourceId, documentType: `${packetType}_patient_file`, status: { $in: ['final', 'preview'] } }, { $set: { status: 'superseded' } });
    const packetSignatures = await DocumentSignature.find({ hospitalId, admissionId: req.params.admissionId, documentType: `${packetType}_patient_file`, status: 'signed' }).sort({ signedAt: 1 }).lean();
    const pdf = await renderPatientFilePdf({ manifest, documents, packetType, hospitalId, signatures: packetSignatures });
    const checksum = sha256(pdf);
    const storagePath = writePatientBundle(pdf, { hospitalId, admissionId: req.params.admissionId, packetType, revision });
    const rendered = await RenderedDocument.create({
      hospitalId,
      patientId: manifest.admission.patient?._id || manifest.admission.patient,
      admissionId: req.params.admissionId,
      documentType: `${packetType}_patient_file`,
      title: `${packetType.replace(/\b\w/g, (char) => char.toUpperCase())} Patient File`,
      sourceModel,
      sourceId,
      sourceRevision: revision,
      templateId: `${packetType}-patient-file`,
      templateVersion: 1,
      storagePath,
      sizeBytes: pdf.length,
      sha256: checksum,
      pageCount: documents.reduce((sum, item) => sum + Number(item.formTemplate?.pageCount || 1), 1),
      signatureIds: packetSignatures.map((signature) => signature._id),
      verificationCodes: packetSignatures.map((signature) => signature.verificationCode).filter(Boolean),
      status: packetSignatures.length ? 'final' : 'preview',
      generatedBy: req.user._id,
      metadata: { packetType, documentKeys: documents.map((item) => item.key), sourceRevisions: documents.map((item) => ({ key: item.key, revision: item.sourceRevision || 1 })), generatedAt: new Date() }
    });
    await EncounterDocument.findOneAndUpdate(
      { hospitalId, sourceModel, sourceId, sourceRevision: revision },
      { $set: { patientId: rendered.patientId, admissionId: req.params.admissionId, encounterType: 'IPD', category: packetType === 'financial' ? 'financial' : 'attachment', documentType: rendered.documentType, title: rendered.title, rendererKey: 'rendered-patient-file', status: rendered.status === 'final' ? 'Final/Signed' : 'Completed/Unsigned', documentDate: rendered.generatedAt, authorUserId: req.user._id, authorName: req.user.name || req.user.email, fileUrl: `/api/documents/patient-file/${req.params.admissionId}/bundles/${rendered._id}`, mimeType: 'application/pdf', templateId: rendered.templateId, templateVersion: '1', metadata: { renderedDocumentId: String(rendered._id), checksum, packetType, documentCount: documents.length }, visibility: packetType === 'financial' ? 'financial' : 'clinical' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.setHeader('X-Rendered-Document-Id', String(rendered._id));
    res.setHeader('X-Content-SHA256', checksum);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${packetType}-patient-file-r${revision}.pdf"`);
    res.send(pdf);
  } catch (error) { next(error); }
};

exports.streamPatientFileBundle = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const rendered = await RenderedDocument.findOne({ _id: req.params.renderedId, hospitalId, admissionId: req.params.admissionId, sourceModel: 'PatientFileBundle' });
    if (!rendered || !fs.existsSync(rendered.storagePath)) return res.status(404).json({ error: 'Rendered patient file not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="${rendered.templateId}-r${rendered.sourceRevision}.pdf"`);
    res.setHeader('ETag', rendered.sha256);
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(rendered.storagePath).pipe(res);
  } catch (error) { next(error); }
};
