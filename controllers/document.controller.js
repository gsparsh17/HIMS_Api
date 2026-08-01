const DocumentSignature = require('../models/DocumentSignature');
const EncounterDocument = require('../models/EncounterDocument');
const { requireHospitalId } = require('../services/tenantScope.service');
const { signDocument } = require('../services/documentSigning.service');
const patientFileManifest = require('../services/patientFileManifest.service');
const RenderedDocument = require('../models/RenderedDocument');
const fs = require('fs');

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
    const packetDefinition = patientFileManifest.packetDefinition(packetType);
    const packetCandidates = patientFileManifest.packetDocuments(packetType, manifest.documents);
    const documents = packetCandidates.filter((document) => req.query.includeDrafts === 'true' || ['Completed/Unsigned', 'Final/Signed'].includes(document.status));
    res.json({ success: true, data: { ...manifest, packetType, packetDefinition: { label: packetDefinition.label, description: packetDefinition.description || '' }, documents, generatedAt: new Date().toISOString() } });
  } catch (error) { next(error); }
};


function selectedBundleDocuments(manifest, body = {}, query = {}) {
  const packetType = body.packetType || query.packetType || 'clinical';
  const packetCandidates = patientFileManifest.packetDocuments(packetType, manifest.documents);
  const selectedKeys = new Set(body.documentKeys || []);
  const includeDrafts = body.includeDrafts === true || query.includeDrafts === 'true';
  const documents = packetCandidates.filter((document) => {
    if (selectedKeys.size && !selectedKeys.has(document.key)) return false;
    return includeDrafts || ['Completed/Unsigned', 'Final/Signed'].includes(document.status);
  });
  return { packetType, documents };
}

exports.previewPatientFileBundle = async (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Server-side patient-file PDF generation has been retired. Open the patient-file builder and print the exact browser preview.'
  });
};

exports.finalizePatientFileBundle = async (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Patient-file bundles are no longer persisted on the backend. Open the patient-file builder and print the exact browser preview.'
  });
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
