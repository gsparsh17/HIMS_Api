'use strict';

const HRStaffProfile = require('../models/HRStaffProfile');
const HRAppraisal = require('../models/HRAppraisal');
const HRWorkflowRule = require('../models/HRWorkflowRule');
const HRInduction = require('../models/HRInduction');
const HRTrainingEvent = require('../models/HRTrainingEvent');
const HRTrainingAttendance = require('../models/HRTrainingAttendance');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [String(value)];
}

function normalizeSteps(rows) {
  return (Array.isArray(rows) ? rows : []).map((s) => ({
    ...s,
    label: s.label || String(s.key || '').replace(/_/g, ' ')
  }));
}

async function employee(req, idOrCode) {
  const f = {
    hospital_id: hospitalId(req)
  };

  if (String(idOrCode).match(/^[a-f\d]{24}$/i)) {
    f._id = idOrCode;
  } else {
    f.employee_code = idOrCode;
  }

  const row = await HRStaffProfile.findOne(f);

  if (!row) {
    const e = new Error('Employee not found');
    e.statusCode = 404;
    throw e;
  }

  return row;
}

exports.appraisal = async (req, res) => {
  try {
    required(req.body, ['employeeId', 'period', 'rating']);

    const emp = await employee(req, req.body.employeeId);

    const row = await HRAppraisal.create({
      hospitalId: hospitalId(req),
      employeeId: emp._id,
      period: req.body.period,
      rating: req.body.rating,
      goals: asArray(req.body.goals),
      strengths: asArray(req.body.strengths),
      improvementAreas: asArray(req.body.improvementAreas),
      comments: req.body.comments,
      appraisedBy: req.user._id,
      appraisedAt: req.body.appraisedAt || new Date()
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.appraisals = async (req, res) => {
  try {
    const emp = await employee(
      req,
      req.query.employeeId || req.query.employeeCode
    );

    const data = await HRAppraisal
      .find({
        hospitalId: hospitalId(req),
        employeeId: emp._id
      })
      .sort({ appraisedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.createRule = async (req, res) => {
  try {
    required(req.body, ['processType', 'name', 'steps']);

    const row = await HRWorkflowRule.create({
      hospitalId: hospitalId(req),
      processType: req.body.processType,
      name: req.body.name,
      steps: normalizeSteps(req.body.steps),
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

exports.evaluateRule = async (req, res) => {
  try {
    const row = await HRWorkflowRule.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req),
      active: true
    });

    if (!row) {
      return res.status(404).json({
        error: 'HR workflow rule not found'
      });
    }

    const completed = new Set((req.body.completedSteps || []).map(String));

    const missing = row.steps
      .filter(s => s.required !== false && !completed.has(String(s.key)))
      .map(s => s.key);

    const hasMissing = missing.length > 0;

    return res.status(hasMissing ? 422 : 200).json({
      success: !hasMissing,
      processType: row.processType,
      missingSteps: missing
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.induction = async (req, res) => {
  try {
    required(req.body, ['employeeId']);

    const emp = await employee(req, req.body.employeeId);

    const isCompleted = (req.body.status || 'completed') === 'completed';

    const row = await HRInduction.findOneAndUpdate(
      {
        hospitalId: hospitalId(req),
        employeeId: emp._id
      },
      {
        $set: {
          completedItems: req.body.completedItems || req.body.completedModules || [],
          status: req.body.status || 'completed',
          feedbackScore: req.body.feedbackScore,
          feedback: req.body.feedback,
          completedAt: isCompleted ? new Date() : undefined,
          recordedBy: req.user._id
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.inductionReport = async (req, res) => {
  try {
    const emp = await employee(
      req,
      req.query.employeeId || req.query.employeeCode
    );

    const data = await HRInduction
      .findOne({
        hospitalId: hospitalId(req),
        employeeId: emp._id
      })
      .lean();

    return res.json({
      success: true,
      employee: {
        _id: emp._id,
        employee_code: emp.employee_code,
        full_name: emp.full_name
      },
      data
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.createTraining = async (req, res) => {
  try {
    required(req.body, ['title', 'category', 'startsAt', 'endsAt']);

    const row = await HRTrainingEvent.create({
      hospitalId: hospitalId(req),
      title: req.body.title,
      category: req.body.category,
      startsAt: req.body.startsAt,
      endsAt: req.body.endsAt,
      venue: req.body.venue,
      trainer: req.body.trainer,
      capacity: req.body.capacity,
      status: 'scheduled',
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

exports.updateTraining = async (req, res) => {
  try {
    const row = await HRTrainingEvent.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Training event not found'
      });
    }

    const updatableFields = [
      'title',
      'category',
      'startsAt',
      'endsAt',
      'venue',
      'trainer',
      'capacity',
      'status'
    ];

    for (const key of updatableFields) {
      if (req.body[key] !== undefined) {
        row[key] = req.body[key];
      }
    }

    row.updatedBy = req.user._id;
    await row.save();

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listTraining = async (req, res) => {
  try {
    const f = {
      hospitalId: hospitalId(req)
    };

    if (req.query.category) {
      f.category = req.query.category;
    }

    if (req.query.status) {
      f.status = req.query.status;
    }

    const data = await HRTrainingEvent
      .find(f)
      .sort({ startsAt: 1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.cancelTraining = async (req, res) => {
  try {
    const row = await HRTrainingEvent.findOneAndUpdate(
      {
        _id: req.params.id,
        hospitalId: hospitalId(req)
      },
      {
        $set: {
          status: 'cancelled',
          updatedBy: req.user._id
        }
      },
      {
        new: true
      }
    );

    if (!row) {
      return res.status(404).json({
        error: 'Training event not found'
      });
    }

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.attendance = async (req, res) => {
  try {
    required(req.body, ['trainingEventId', 'employeeId', 'attendanceStatus']);

    const emp = await employee(req, req.body.employeeId);

    const event = await HRTrainingEvent.findOne({
      _id: req.body.trainingEventId,
      hospitalId: hospitalId(req)
    });

    if (!event) {
      return res.status(404).json({
        error: 'Training event not found'
      });
    }

    const row = await HRTrainingAttendance.findOneAndUpdate(
      {
        hospitalId: hospitalId(req),
        trainingEventId: event._id,
        employeeId: emp._id
      },
      {
        $set: {
          attendanceStatus: req.body.attendanceStatus,
          feedbackScore: req.body.feedbackScore,
          feedback: req.body.feedback,
          assessmentScore: req.body.assessmentScore,
          recordedBy: req.user._id
        }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.trainingReport = async (req, res) => {
  try {
    const hid = hospitalId(req);

    const rows = await HRTrainingAttendance
      .find({ hospitalId: hid })
      .populate('trainingEventId', 'title category startsAt')
      .populate('employeeId', 'employee_code full_name')
      .lean();

    const attended = rows.filter(x => x.attendanceStatus === 'present').length;
    const scored = rows.filter(x => Number.isFinite(x.feedbackScore));

    const averageFeedback = scored.length
      ? scored.reduce((sum, x) => sum + x.feedbackScore, 0) / scored.length
      : null;

    return res.json({
      success: true,
      data: {
        totalAttendanceRecords: rows.length,
        present: attended,
        averageFeedback,
        rows
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};