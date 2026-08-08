'use strict';

const SafetyIncident = require('../models/SafetyIncident');
const { queueNotification } = require('../services/nabhNotification.service');
const SafetyPolicy = require('../models/SafetyPolicy');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');

const TYPES = [
  'infection',
  'patient_safety',
  'sentinel_event',
  'staff_exposure',
  'transfusion',
  'medication_error',
  'medication_near_miss',
  'adverse_drug_reaction'
];

exports.createIncident = async (req, res) => {
  try {
    const category = req.body.category || req.body.title;
    required({ ...req.body, category }, ['incidentType', 'category', 'details']);

    if (!TYPES.includes(req.body.incidentType)) {
      return res.status(400).json({
        error: 'Unsupported incidentType'
      });
    }

    const row = await SafetyIncident.create({
      hospitalId: hospitalId(req),
      incidentNumber: req.body.incidentNumber || ref('INC'),
      incidentType: req.body.incidentType,
      patientId: req.body.patientId,
      staffId: req.body.staffId,
      category,
      severity: req.body.severity || 'moderate',
      status: req.body.status || 'open',
      occurredAt: req.body.occurredAt || new Date(),
      details: req.body.details,
      correctiveActions: req.body.correctiveActions || [],
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    const notification = await queueNotification({
      hospitalId: hospitalId(req),
      eventType: `safety_${row.incidentType}`,
      correlationId: row.incidentNumber,
      recipientType: 'staff',
      recipientName: req.body.notifyRole || 'safety_team',
      requestedChannels: ['portal'],
      priority: ['high', 'critical'].includes(row.severity) ? 'critical' : 'high',
      subject: `Safety incident ${row.incidentNumber}`,
      body: `${row.category}: ${typeof row.details === 'string'
        ? row.details
        : JSON.stringify(row.details).slice(0, 500)}`,
      patientId: row.patientId,
      payload: {
        incidentId: row._id,
        incidentType: row.incidentType,
        severity: row.severity
      },
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row,
      notification
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.updateIncident = async (req, res) => {
  try {
    const row = await SafetyIncident.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Incident not found'
      });
    }

    const updatableFields = ['status', 'severity', 'category', 'details', 'correctiveActions'];

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

exports.list = async (req, res) => {
  try {
    const filter = {
      hospitalId: hospitalId(req)
    };

    const queryFields = ['incidentType', 'category', 'status'];

    for (const key of queryFields) {
      if (req.query[key]) {
        filter[key] = req.query[key];
      }
    }

    const data = await SafetyIncident
      .find(filter)
      .sort({ occurredAt: -1 })
      .limit(250)
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.analytics = async (req, res) => {
  try {
    const rows = await SafetyIncident
      .find({
        hospitalId: hospitalId(req)
      })
      .lean();

    const byType = {};
    const bySeverity = {};
    const byStatus = {};

    for (const x of rows) {
      byType[x.incidentType] = (byType[x.incidentType] || 0) + 1;
      bySeverity[x.severity] = (bySeverity[x.severity] || 0) + 1;
      byStatus[x.status] = (byStatus[x.status] || 0) + 1;
    }

    return res.json({
      success: true,
      data: {
        total: rows.length,
        byType,
        bySeverity,
        byStatus
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.createPolicy = async (req, res) => {
  try {
    required(req.body, ['name', 'version', 'content']);

    const content = { ...req.body.content };

    // Ensure restrictedAntibiotics array exists
    if (!Array.isArray(content.restrictedAntibiotics) && Array.isArray(content.restrictedClasses)) {
      content.restrictedAntibiotics = content.restrictedClasses;
    }

    // Ensure approvalRules array exists
    if (!Array.isArray(content.approvalRules) && content.requireJustification !== undefined) {
      content.approvalRules = [{
        scope: 'restricted_antibiotic',
        requiresJustification: Boolean(content.requireJustification),
        requiresApproval: true
      }];
    }

    // Validate required arrays
    if (!Array.isArray(content.restrictedAntibiotics) || !Array.isArray(content.approvalRules)) {
      return res.status(400).json({
        error: 'Antimicrobial policy requires restrictedAntibiotics and approvalRules'
      });
    }

    const row = await SafetyPolicy.create({
      hospitalId: hospitalId(req),
      policyType: 'antimicrobial_usage',
      name: req.body.name,
      version: req.body.version,
      content,
      active: req.body.active !== false,
      effectiveFrom: req.body.effectiveFrom || new Date(),
      approvedBy: req.user._id,
      approvedAt: new Date(),
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

exports.policies = async (req, res) => {
  try {
    const data = await SafetyPolicy
      .find({
        hospitalId: hospitalId(req),
        policyType: 'antimicrobial_usage',
        active: true
      })
      .sort({ effectiveFrom: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};