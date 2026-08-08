'use strict';

const PatientAnnouncement = require('../models/PatientAnnouncement');
const PatientExperienceSurvey = require('../models/PatientExperienceSurvey');
const PatientExperienceResponse = require('../models/PatientExperienceResponse');
const Hospital = require('../models/Hospital');
const Patient = require('../models/Patient');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');

function normalizeLocalized(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return {
    en: String(value || '').trim()
  };
}

function normalizeQuestions(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => ({
    key: String(row?.key || '').trim(),
    text: normalizeLocalized(row?.text || row?.label || row?.key),
    type: row?.type === 'rating' ? 'rating_1_5' : (row?.type || 'rating_1_5'),
    required: row?.required !== false
  }));
}

exports.createAnnouncement = async (req, res) => {
  try {
    required(req.body, ['title', 'message']);

    const row = await PatientAnnouncement.create({
      hospitalId: hospitalId(req),
      title: req.body.title,
      message: req.body.message,
      audience: req.body.audience || 'all',
      active: req.body.active !== false,
      startsAt: req.body.startsAt || new Date(),
      endsAt: req.body.endsAt,
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.announcements = async (req, res) => {
  try {
    const now = new Date();
    const locale = String(req.query.locale || 'en');

    const rows = await PatientAnnouncement
      .find({
        hospitalId: hospitalId(req),
        active: true,
        startsAt: { $lte: now },
        $or: [
          { endsAt: null },
          { endsAt: { $exists: false } },
          { endsAt: { $gte: now } }
        ]
      })
      .sort({ createdAt: -1 })
      .lean();

    const data = rows.map(x => ({
      ...x,
      displayTitle: x.title?.[locale] ||
                   x.title?.en ||
                   Object.values(x.title || {})[0],
      displayMessage: x.message?.[locale] ||
                     x.message?.en ||
                     Object.values(x.message || {})[0]
    }));

    return res.json({
      success: true,
      data,
      locale
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.createSurvey = async (req, res) => {
  try {
    required(req.body, ['surveyType', 'name', 'questions']);

    if (!['feedback', 'prom', 'prem'].includes(req.body.surveyType)) {
      return res.status(400).json({
        error: 'Invalid surveyType'
      });
    }

    const questions = normalizeQuestions(req.body.questions);

    if (!questions.length || questions.some((q) => !q.key || !q.text?.en)) {
      return res.status(400).json({
        error: 'Every survey question requires key and text/label'
      });
    }

    const row = await PatientExperienceSurvey.create({
      hospitalId: hospitalId(req),
      surveyType: req.body.surveyType,
      name: req.body.name,
      version: req.body.version || 1,
      questions,
      active: req.body.active !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listSurveys = async (req, res) => {
  try {
    const f = {
      hospitalId: hospitalId(req),
      active: true
    };

    if (req.query.surveyType) {
      f.surveyType = req.query.surveyType;
    }

    const data = await PatientExperienceSurvey
      .find(f)
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.submit = async (req, res) => {
  try {
    required(req.body, ['responseType']);

    if (!['feedback', 'complaint', 'prom', 'prem'].includes(req.body.responseType)) {
      return res.status(400).json({
        error: 'Invalid responseType'
      });
    }

    if (req.body.patientId) {
      const patient = await Patient.exists({
        _id: req.body.patientId,
        hospitalId: hospitalId(req)
      });

      if (!patient) {
        return res.status(404).json({
          error: 'Patient not found'
        });
      }
    }

    let survey = null;

    if (req.body.surveyId) {
      survey = await PatientExperienceSurvey.findOne({
        _id: req.body.surveyId,
        hospitalId: hospitalId(req),
        active: true
      });

      if (!survey) {
        return res.status(404).json({
          error: 'Survey not found'
        });
      }

      const missing = survey.questions
        .filter(q => q.required !== false && (
          req.body.responses?.[q.key] === undefined ||
          req.body.responses?.[q.key] === null
        ))
        .map(q => q.key);

      if (missing.length) {
        return res.status(422).json({
          error: 'Required survey questions are missing',
          fields: missing
        });
      }
    }

    const numeric = Object
      .values(req.body.responses || {})
      .map(Number)
      .filter(Number.isFinite);

    const score = req.body.score !== undefined
      ? Number(req.body.score)
      : (numeric.length
        ? numeric.reduce((a, b) => a + b, 0) / numeric.length
        : undefined);

    const isComplaint = req.body.responseType === 'complaint';

    const row = await PatientExperienceResponse.create({
      hospitalId: hospitalId(req),
      referenceNumber: req.body.referenceNumber || ref(isComplaint ? 'CMP' : 'EXP'),
      responseType: req.body.responseType,
      patientId: req.body.patientId,
      surveyId: survey?._id,
      locale: req.body.locale || 'en',
      responses: req.body.responses || {},
      score,
      category: req.body.category,
      comments: req.body.comments,
      status: isComplaint ? 'open' : 'submitted',
      source: req.body.source || 'portal',
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.resolveComplaint = async (req, res) => {
  try {
    required(req.body, ['note']);

    const row = await PatientExperienceResponse.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req),
      responseType: 'complaint'
    });

    if (!row) {
      return res.status(404).json({
        error: 'Complaint not found'
      });
    }

    row.status = 'resolved';
    row.resolution = {
      note: req.body.note,
      resolvedAt: new Date(),
      resolvedBy: req.user._id
    };

    await row.save();

    let notification = null;

    if (row.patientId) {
      notification = await queueNotification({
        hospitalId: hospitalId(req),
        eventType: 'complaint_resolved',
        correlationId: row.referenceNumber,
        recipientType: 'patient',
        requestedChannels: ['portal'],
        priority: 'normal',
        subject: 'Complaint resolution update',
        body: req.body.note,
        patientId: row.patientId,
        payload: {
          referenceNumber: row.referenceNumber
        },
        createdBy: req.user._id
      });
    }

    return res.json({
      success: true,
      data: row,
      notification
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.analytics = async (req, res) => {
  try {
    const rows = await PatientExperienceResponse
      .find({
        hospitalId: hospitalId(req)
      })
      .lean();

    const byType = {};
    const byCategory = {};

    for (const x of rows) {
      const type = byType[x.responseType] || {
        count: 0,
        scoreCount: 0,
        scoreTotal: 0
      };

      type.count++;

      if (Number.isFinite(x.score)) {
        type.scoreCount++;
        type.scoreTotal += x.score;
      }

      byType[x.responseType] = type;

      const category = x.category || 'uncategorized';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    for (const b of Object.values(byType)) {
      b.averageScore = b.scoreCount
        ? Math.round((b.scoreTotal / b.scoreCount) * 100) / 100
        : null;

      delete b.scoreTotal;
    }

    return res.json({
      success: true,
      data: {
        total: rows.length,
        byType,
        byCategory
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.updateCertifications = async (req, res) => {
  try {
    if (!Array.isArray(req.body.certifications)) {
      return res.status(400).json({
        error: 'certifications array is required'
      });
    }

    const hospital = await Hospital.findOneAndUpdate(
      { _id: hospitalId(req) },
      { $set: { certifications: req.body.certifications } },
      {
        new: true,
        runValidators: true
      }
    )
      .select('hospitalName hospitalID tenantCode certifications');

    if (!hospital) {
      return res.status(404).json({
        error: 'Hospital not found'
      });
    }

    return res.json({
      success: true,
      data: hospital
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.profile = async (req, res) => {
  try {
    const hospital = await Hospital
      .findById(hospitalId(req))
      .select('hospitalName hospitalID tenantCode logo city state certifications')
      .lean();

    return res.json({
      success: true,
      data: hospital
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.sendSurvey = async (req, res) => {
  try {
    const surveyId = req.params.surveyId || req.body.surveyId;

    required({ ...req.body, surveyId }, ['patientId', 'surveyId']);

    const patient = await Patient
      .findOne({
        _id: req.body.patientId,
        hospitalId: hospitalId(req)
      })
      .select('phone email');

    if (!patient) {
      return res.status(404).json({
        error: 'Patient not found'
      });
    }

    const survey = await PatientExperienceSurvey.findOne({
      _id: surveyId,
      hospitalId: hospitalId(req),
      active: true
    });

    if (!survey) {
      return res.status(404).json({
        error: 'Survey not found'
      });
    }

    const requestedChannels = (req.body.channels || ['portal']).filter(Boolean);

    const delivery = await queueNotification({
      hospitalId: hospitalId(req),
      eventType: `${survey.surveyType}_survey_invite`,
      correlationId: String(survey._id),
      recipientType: 'patient',
      requestedChannels,
      contact: {
        phone: patient.phone,
        email: patient.email
      },
      priority: 'normal',
      subject: `${survey.name} survey`,
      body: req.body.message || `Please complete ${survey.name}`,
      patientId: patient._id,
      payload: {
        surveyId: survey._id,
        surveyType: survey.surveyType
      },
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: delivery
    });
  } catch (e) {
    return sendError(res, e);
  }
};