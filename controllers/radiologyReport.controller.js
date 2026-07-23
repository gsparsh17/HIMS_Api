const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const RadiologyRequest = require('../models/RadiologyRequest');
const Hospital = require('../models/Hospital');
const { catalogVersion, listTemplates, getTemplate, matchTemplateDetailed } = require('../services/radiologyReportTemplate.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { generateRadiologyReportPdf } = require('../services/radiologyPdf.service');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const clean = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  const output = String(value).trim();
  return output || fallback;
};

const safeUnlink = (filePath) => {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
};

const signatureIsValid = (file) => {
  if (!file?.path) return false;
  const fd = fs.openSync(file.path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (file.mimetype === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (['image/jpeg', 'image/jpg'].includes(file.mimetype)) return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return false;
  } finally { fs.closeSync(fd); }
};

exports.getTemplates = async (req, res) => {
  const templates = listTemplates({ q: req.query.q || '', limit: req.query.limit || 100 });
  res.json({ success: true, version: catalogVersion, count: templates.length, data: templates });
};

exports.getTemplate = async (req, res) => {
  const template = getTemplate(req.params.templateId);
  if (!template) return res.status(404).json({ error: 'Radiology report template not found' });
  res.json({ success: true, version: catalogVersion, data: template });
};

exports.matchTemplate = async (req, res) => {
  const match = matchTemplateDetailed(req.query.testName || '', req.query.testCode || '', req.query.templateId || '');
  if (!match) return res.status(404).json({ error: 'No confident radiology template match found' });
  res.json({ success: true, version: catalogVersion, data: match.template, match: { score: match.score, confidence: match.confidence, matchedOn: match.matchedOn } });
};

exports.saveManualReport = async (req, res) => {
  const files = req.files || [];
  try {
    const request = await RadiologyRequest.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req) });
    if (!request) return res.status(404).json({ error: 'Radiology request not found' });
    const payload = JSON.parse(req.body.report || '{}');
    const template = getTemplate(payload.templateId || request.reportTemplateId);
    if (!template) return res.status(400).json({ error: 'Select a valid radiology report template' });
    const sections = (payload.sections || []).map((item, index) => ({
      key: clean(item.key, `section-${index + 1}`),
      label: clean(item.label, `Section ${index + 1}`),
      text: clean(item.text)
    }));
    if (!sections.some((item) => item.text)) return res.status(400).json({ error: 'Enter at least one report section' });
    const missingRequired = (template.sections || [])
      .filter((item) => item.required)
      .filter((requiredItem) => !sections.some((item) => item.key === requiredItem.key && item.text));
    if (missingRequired.length) {
      return res.status(400).json({ error: `Complete required report sections: ${missingRequired.map((item) => item.label).join(', ')}` });
    }
    if (files.some((file) => !signatureIsValid(file))) return res.status(400).json({ error: 'One or more attached images are not valid JPG or PNG files' });

    const uploadedImages = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const result = await cloudinary.uploader.upload(file.path, {
        folder: 'radiology_report_images',
        resource_type: 'image',
        public_id: `rad_img_${request.requestNumber}_${Date.now()}_${index}`,
        access_mode: 'public'
      });
      uploadedImages.push({
        url: result.secure_url,
        publicId: result.public_id,
        caption: clean(payload.imageCaptions?.[index]),
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size
      });
      safeUnlink(file.path);
    }

    const priorImages = Array.isArray(request.manual_report?.images)
      ? request.manual_report.images.map((image) => image.toObject?.() || image)
      : [];
    request.reportTemplateId = template.id;
    request.reportTemplateName = template.name;
    request.report_mode = 'manual';
    request.report_url = undefined;
    request.public_id = undefined;
    request.manual_report = {
      templateId: template.id,
      templateNumber: template.number,
      templateVersion: template.version,
      templateName: template.name,
      sections,
      tables: Array.isArray(payload.tables) ? payload.tables : [],
      images: payload.keepExistingImages === false ? uploadedImages : [...priorImages, ...uploadedImages].slice(0, template.maxImages || 6),
      radiologistName: clean(payload.radiologistName),
      technicianName: clean(payload.technicianName),
      disclaimer: clean(payload.disclaimer),
      reportedAt: new Date(),
      reportedBy: req.user?._id
    };
    request.findings = clean(sections.find((item) => /findings/i.test(item.key))?.text || sections.find((item) => /findings/i.test(item.label))?.text);
    request.impression = clean(sections.find((item) => /impression/i.test(item.key))?.text || sections.find((item) => /impression/i.test(item.label))?.text);
    request.status = 'Result Entered';
    request.resultEnteredAt = new Date();
    await request.save();
    res.json({ success: true, message: 'Structured radiology report saved', data: request });
  } catch (error) {
    console.error('Error saving structured radiology report:', error);
    res.status(500).json({ error: error.message });
  } finally {
    files.forEach((file) => safeUnlink(file.path));
  }
};

exports.downloadGeneratedReport = async (req, res) => {
  try {
    const request = await RadiologyRequest.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req) })
      .populate('patientId')
      .populate('doctorId')
      .populate('admissionId', 'admissionNumber hospitalId')
      .populate('appointmentId', 'token')
      .populate({ path: 'prescriptionId', select: 'appointment_id', populate: { path: 'appointment_id', select: 'token' } });
    if (!request || request.report_mode !== 'manual' || !request.manual_report) return res.status(404).json({ error: 'Structured radiology report not found' });
    const hospitalId = request.admissionId?.hospitalId || req.user?.hospital_id;
    let hospital = hospitalId ? await Hospital.findById(hospitalId) : null;
    if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
    await generateRadiologyReportPdf({ request, hospital, res });
  } catch (error) {
    console.error('Error generating radiology PDF:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
};
