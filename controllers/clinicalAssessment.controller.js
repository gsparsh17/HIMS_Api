'use strict';

const ClinicalAssessmentDefinition = require('../models/ClinicalAssessmentDefinition');
const ClinicalAssessmentRecord = require('../models/ClinicalAssessmentRecord');
const PatientDietOrder = require('../models/PatientDietOrder');
const Patient = require('../models/Patient');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');
const { operationNow } = require('../utils/operationTimeContext');

async function patient(req, id) {
  const p = await Patient
    .findOne({
      _id: id,
      hospitalId: hospitalId(req)
    })
    .select('_id');

  if (!p) {
    const e = new Error('Patient not found');
    e.statusCode = 404;
    throw e;
  }

  return p;
}

exports.createDefinition = async (req, res) => {
  try {
    required(req.body, ['definitionType', 'name', 'sourceReference', 'definition']);

    const isDraft = req.body.governanceStatus === 'draft';

    const row = await ClinicalAssessmentDefinition.create({
      hospitalId: hospitalId(req),
      definitionType: req.body.definitionType,
      name: req.body.name,
      version: req.body.version || '1',
      sourceReference: req.body.sourceReference,
      definition: req.body.definition,
      governanceStatus: req.body.governanceStatus || 'approved',
      validatedBy: req.user._id,
      validatedAt: new Date(),
      approvedBy: isDraft ? undefined : req.user._id,
      approvedAt: isDraft ? undefined : new Date(),
      effectiveFrom: req.body.effectiveFrom || new Date(),
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

exports.listDefinitions = async (req, res) => {
  const f = {
    hospitalId: hospitalId(req)
  };

  if (req.query.definitionType) {
    f.definitionType = req.query.definitionType;
  }

  const data = await ClinicalAssessmentDefinition
    .find(f)
    .sort({ createdAt: -1 })
    .lean();

  return res.json({
    success: true,
    data
  });
};

exports.evaluateIcu = async (req, res) => {
  try {
    required(req.body, ['patientId', 'definitionId']);

    await patient(req, req.body.patientId);

    const def = await ClinicalAssessmentDefinition.findOne({
      _id: req.body.definitionId,
      hospitalId: hospitalId(req),
      definitionType: 'icu_criteria',
      governanceStatus: 'approved'
    });

    if (!def) {
      return res.status(404).json({
        error: 'Approved ICU definition not found'
      });
    }

    const decisionType = String(req.body.decisionType || 'admission').toLowerCase();

    if (!['admission', 'discharge'].includes(decisionType)) {
      return res.status(400).json({
        error: 'decisionType must be admission or discharge'
      });
    }

    const obs = req.body.observations || {};
    const key = decisionType === 'discharge' ? 'dischargeCriteria' : 'admissionCriteria';

    const criteria = Array.isArray(def.definition?.[key])
      ? def.definition[key]
      : (Array.isArray(def.definition?.criteria)
        ? def.definition.criteria
        : []);

    const matched = criteria.filter(c => {
      const raw = obs[c.key];
      const v = Number(raw);
      const t = Number(c.threshold);

      if (c.operator === '==') {
        return String(raw) === String(c.value ?? c.threshold);
      }

      if (c.operator === '!=') {
        return String(raw) !== String(c.value ?? c.threshold);
      }

      if (!Number.isFinite(v) || !Number.isFinite(t)) {
        return false;
      }

      if (c.operator === '>=') return v >= t;
      if (c.operator === '>') return v > t;
      if (c.operator === '<=') return v <= t;
      if (c.operator === '<') return v < t;

      return false;
    });

    const minKey = decisionType === 'discharge'
      ? 'minimumDischargeMatches'
      : 'minimumAdmissionMatches';

    const minMatches = Number(
      def.definition?.[minKey] ??
      def.definition?.minimumMatches ??
      1
    );

    const eligible = matched.length >= minMatches;

    const row = await ClinicalAssessmentRecord.create({
      hospitalId: hospitalId(req),
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      appointmentId: req.body.appointmentId,
      assessmentType: 'icu_eligibility',
      definitionId: def._id,
      definitionVersion: def.version,
      observations: obs,
      eligible,
      result: {
        decisionType,
        matchedCriteria: matched.map(c => c.key),
        minimumMatches: minMatches,
        recommendation: eligible
          ? (decisionType === 'admission'
            ? 'consider_icu_admission'
            : 'consider_icu_discharge')
          : 'criteria_not_met'
      },
      assessedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.mortality = async (req, res) => {
  try {
    required(req.body, ['patientId', 'definitionId', 'score']);

    await patient(req, req.body.patientId);

    const def = await ClinicalAssessmentDefinition.findOne({
      _id: req.body.definitionId,
      hospitalId: hospitalId(req),
      definitionType: 'mortality_scale',
      governanceStatus: 'approved'
    });

    if (!def) {
      return res.status(404).json({
        error: 'Approved mortality definition not found'
      });
    }

    const score = Number(req.body.score);
    const bands = def.definition?.bands || [];

    const band = bands.find(b =>
      score >= Number(b.min) && score <= Number(b.max)
    );

    if (!band) {
      return res.status(422).json({
        error: 'Score is outside configured scale'
      });
    }

    const row = await ClinicalAssessmentRecord.create({
      hospitalId: hospitalId(req),
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      assessmentType: 'mortality_score',
      definitionId: def._id,
      definitionVersion: def.version,
      score,
      riskBand: band.label || String(band.riskPercent),
      result: {
        riskPercent: Number(band.riskPercent)
      },
      assessedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.rehabilitation = async (req, res) => {
  try {
    required(req.body, ['patientId', 'definitionId', 'baseline', 'treatmentPlan']);

    await patient(req, req.body.patientId);

    const def = await ClinicalAssessmentDefinition.findOne({
      _id: req.body.definitionId,
      hospitalId: hospitalId(req),
      definitionType: 'functional_scale',
      governanceStatus: 'approved'
    });

    if (!def) {
      return res.status(404).json({
        error: 'Approved functional assessment scale not found'
      });
    }

    const previous = await ClinicalAssessmentRecord
      .findOne({
        hospitalId: hospitalId(req),
        patientId: req.body.patientId,
        assessmentType: 'rehabilitation'
      })
      .sort({ assessedAt: -1 });

    const row = await ClinicalAssessmentRecord.create({
      hospitalId: hospitalId(req),
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      assessmentType: 'rehabilitation',
      definitionId: def._id,
      definitionVersion: def.version,
      observations: req.body.baseline,
      score: req.body.score,
      result: req.body.outcomes || {},
      treatmentPlan: req.body.treatmentPlan,
      supersedesId: previous?._id,
      assessedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row,
      scale: {
        name: def.name,
        version: def.version
      },
      previousId: previous?._id || null
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.createDiet = async (req, res) => {
  try {
    required(req.body, ['patientId', 'dietType']);

    await patient(req, req.body.patientId);

    await PatientDietOrder.updateMany(
      {
        hospitalId: hospitalId(req),
        patientId: req.body.patientId,
        status: 'active'
      },
      {
        $set: {
          status: 'completed',
          endsAt: operationNow()
        }
      }
    );

    const row = await PatientDietOrder.create({
      hospitalId: hospitalId(req),
      patientId: req.body.patientId,
      admissionId: req.body.admissionId,
      dietType: req.body.dietType,
      instructions: req.body.instructions,
      allergiesConsidered: Boolean(req.body.allergiesConsidered),
      startsAt: req.body.startsAt || operationNow(),
      orderedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.dietHistory = async (req, res) => {
  try {
    const data = await PatientDietOrder
      .find({
        hospitalId: hospitalId(req),
        patientId: req.params.patientId
      })
      .sort({ startsAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.patientAssessments = async (req, res) => {
  const f = {
    hospitalId: hospitalId(req),
    patientId: req.params.patientId
  };

  if (req.query.assessmentType) {
    f.assessmentType = req.query.assessmentType;
  }

  const data = await ClinicalAssessmentRecord
    .find(f)
    .sort({ assessedAt: -1 })
    .lean();

  return res.json({
    success: true,
    data
  });
};

exports.activeDiets = async (req, res) => {
  try {
    const f = {
      hospitalId: hospitalId(req),
      status: 'active'
    };

    if (req.query.admissionId) {
      f.admissionId = req.query.admissionId;
    }

    const data = await PatientDietOrder
      .find(f)
      .populate('patientId', 'patientId uhid first_name last_name')
      .sort({ startsAt: -1 })
      .lean();

    return res.json({
      success: true,
      data,
      view: 'kitchen_and_clinical'
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};