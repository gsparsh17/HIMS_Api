const IPDConsent = require('../models/IPDConsent');
const IPDAdmission = require('../models/IPDAdmission');
const Hospital = require('../models/Hospital');
const { version, templates } = require('../data/ipdConsentTemplates');
const { generateConsentPdf } = require('../services/consentPdf.service');

const findTemplate = (id) => templates.find((template) => template.id === id);

exports.listTemplates = async (req, res) => {
  res.json({ success: true, version, data: templates });
};

exports.listAdmissionConsents = async (req, res) => {
  try {
    const admission = await IPDAdmission.findById(req.params.admissionId).select('_id patientId hospitalId');
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    const records = await IPDConsent.find({ admissionId: admission._id }).sort({ updatedAt: -1 });
    const recordMap = new Map(records.map((record) => [record.templateId, record]));
    res.json({
      success: true,
      version,
      data: templates.map((template) => ({ template, consent: recordMap.get(template.id) || null }))
    });
  } catch (error) {
    console.error('Error loading IPD consent forms:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getConsent = async (req, res) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const consent = await IPDConsent.findOne({ admissionId: req.params.admissionId, templateId: template.id });
    res.json({ success: true, data: { template, consent } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.saveConsent = async (req, res) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await IPDAdmission.findById(req.params.admissionId);
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    const responses = req.body.responses && typeof req.body.responses === 'object' ? req.body.responses : {};
    const status = req.body.status === 'Completed' ? 'Completed' : 'Draft';
    if (status === 'Completed') {
      const missing = (template.fields || []).filter((field) => field.required).filter((field) => {
        const value = responses[field.key];
        return value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
      });
      if (missing.length) return res.status(400).json({ error: `Complete required fields: ${missing.map((field) => field.label).join(', ')}` });
    }
    const update = {
      hospitalId: admission.hospitalId || req.user?.hospital_id,
      patientId: admission.patientId,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      status,
      responses,
      notes: req.body.notes || '',
      updatedBy: req.user?._id,
      ...(status === 'Completed' ? { completedAt: new Date(), completedBy: req.user?._id } : {})
    };
    const consent = await IPDConsent.findOneAndUpdate(
      { admissionId: admission._id, templateId: template.id },
      { $set: update, $setOnInsert: { admissionId: admission._id, createdBy: req.user?._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, message: status === 'Completed' ? 'Consent form completed' : 'Consent draft saved', data: consent });
  } catch (error) {
    console.error('Error saving IPD consent:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.printConsent = async (req, res) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const [consent, admission] = await Promise.all([
      IPDConsent.findOne({ admissionId: req.params.admissionId, templateId: template.id }),
      IPDAdmission.findById(req.params.admissionId)
        .populate('patientId')
        .populate('wardId', 'name wardName')
        .populate('bedId', 'bedNumber name')
    ]);
    if (!consent) return res.status(404).json({ error: 'Consent form has not been saved' });
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    const hospitalId = admission.hospitalId || req.user?.hospital_id;
    let hospital = hospitalId ? await Hospital.findById(hospitalId) : null;
    if (!hospital) hospital = await Hospital.findOne();
    generateConsentPdf({ consent, template, admission, hospital, res });
  } catch (error) {
    console.error('Error printing IPD consent:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
};
