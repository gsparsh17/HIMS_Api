const ClinicalTemplate = require('../models/ClinicalTemplate');
const { roundTemplates, dischargeTemplates } = require('../data/defaultClinicalTemplates');
const { requireHospitalId } = require('../services/tenantScope.service');

function normaliseSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `template-${Date.now()}`;
}

function cleanKeywords(keywords) {
  const rows = Array.isArray(keywords)
    ? keywords
    : String(keywords || '').split(',');

  return [...new Set(rows.map((row) => String(row).trim()).filter(Boolean))];
}

async function ensureDefaultTemplates(hospitalId) {
  const defaults = [
    ...roundTemplates.map((template) => ({ ...template, templateType: 'round' })),
    ...dischargeTemplates.map((template) => ({ ...template, templateType: 'discharge_summary' }))
  ];

  await Promise.all(defaults.map((template) => ClinicalTemplate.updateOne(
    {
      hospitalId,
      templateType: template.templateType,
      slug: template.slug
    },
    {
      $setOnInsert: {
        hospitalId,
        templateType: template.templateType,
        name: template.name,
        slug: template.slug,
        diseaseName: template.diseaseName,
        diagnosisKeywords: template.diagnosisKeywords,
        content: template.content,
        isSystemDefault: true,
        isActive: true
      }
    },
    { upsert: true }
  )));
}

exports.listTemplates = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    await ensureDefaultTemplates(hospitalId);

    const filter = { hospitalId };
    const conditions = [];
    if (req.query.type) filter.templateType = req.query.type;
    if (req.query.active !== 'all') filter.isActive = req.query.active !== 'false';

    if (req.query.departmentId) {
      conditions.push({
        $or: [
          { departmentId: req.query.departmentId },
          { departmentId: null },
          { departmentId: { $exists: false } }
        ]
      });
    }

    const search = String(req.query.search || req.query.disease || '').trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      conditions.push({
        $or: [
          { name: regex },
          { diseaseName: regex },
          { diagnosisKeywords: regex }
        ]
      });
    }
    if (conditions.length) filter.$and = conditions;


    const templates = await ClinicalTemplate.find(filter)
      .populate('departmentId', 'name')
      .sort({ isSystemDefault: -1, usageCount: -1, diseaseName: 1, name: 1 });

    return res.json({ success: true, templates });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { templateType, name, diseaseName, content } = req.body || {};

    if (!['round', 'discharge_summary'].includes(templateType)) {
      return res.status(400).json({ error: 'A valid template type is required' });
    }
    if (!String(name || '').trim()) {
      return res.status(400).json({ error: 'Template name is required' });
    }
    if (!String(diseaseName || '').trim()) {
      return res.status(400).json({ error: 'Disease or clinical condition is required' });
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return res.status(400).json({ error: 'Template content must be an object' });
    }

    const baseSlug = normaliseSlug(req.body.slug || `${templateType}-${diseaseName}-${name}`);
    let slug = baseSlug;
    let counter = 2;
    while (await ClinicalTemplate.exists({ hospitalId, templateType, slug })) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const template = await ClinicalTemplate.create({
      hospitalId,
      templateType,
      name: String(name).trim(),
      slug,
      diseaseName: String(diseaseName).trim(),
      diagnosisKeywords: cleanKeywords(req.body.diagnosisKeywords),
      departmentId: req.body.departmentId || undefined,
      content,
      isActive: req.body.isActive !== false,
      isSystemDefault: false,
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });

    return res.status(201).json({
      success: true,
      message: 'Clinical template saved successfully',
      template
    });
  } catch (error) {
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.message });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const template = await ClinicalTemplate.findOne({ _id: req.params.id, hospitalId });
    if (!template) return res.status(404).json({ error: 'Clinical template not found' });

    const editableFields = [
      'name',
      'diseaseName',
      'departmentId',
      'content',
      'isActive'
    ];

    for (const field of editableFields) {
      if (req.body[field] !== undefined) template[field] = req.body[field];
    }
    if (req.body.diagnosisKeywords !== undefined) {
      template.diagnosisKeywords = cleanKeywords(req.body.diagnosisKeywords);
    }
    template.updatedBy = req.user?._id;
    await template.save();

    return res.json({
      success: true,
      message: 'Clinical template updated successfully',
      template
    });
  } catch (error) {
    return res.status(error.code === 11000 ? 409 : 500).json({ error: error.message });
  }
};

exports.deactivateTemplate = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const template = await ClinicalTemplate.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      {
        $set: {
          isActive: false,
          updatedBy: req.user?._id
        }
      },
      { new: true }
    );

    if (!template) return res.status(404).json({ error: 'Clinical template not found' });
    return res.json({ success: true, message: 'Clinical template deactivated', template });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.recordTemplateUse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const template = await ClinicalTemplate.findOneAndUpdate(
      { _id: req.params.id, hospitalId, isActive: true },
      {
        $inc: { usageCount: 1 },
        $set: { lastUsedAt: new Date() }
      },
      { new: true }
    );

    if (!template) return res.status(404).json({ error: 'Clinical template not found' });
    return res.json({ success: true, template });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};
