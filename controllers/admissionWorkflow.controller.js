'use strict';

const AdmissionWorkflowPolicy = require('../models/AdmissionWorkflowPolicy');
const IPDAdmission = require('../models/IPDAdmission');
const Bed = require('../models/Bed');
const Patient = require('../models/Patient');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

exports.createPolicy = async (req, res) => {
  try {
    required(req.body, ['admissionType']);

    const row = await AdmissionWorkflowPolicy.create({
      hospitalId: hospitalId(req),
      admissionType: String(req.body.admissionType).toLowerCase(),
      version: Number(req.body.version || 1),
      requiredDocuments: req.body.requiredDocuments || [],
      requiredSteps: req.body.requiredSteps || [],
      active: req.body.active !== false,
      effectiveFrom: req.body.effectiveFrom || new Date(),
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({ success: true, data: row });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listPolicies = async (req, res) => {
  const filter = {
    hospitalId: hospitalId(req),
    active: true
  };

  if (req.query.admissionType) {
    filter.admissionType = String(req.query.admissionType).toLowerCase();
  }

  const data = await AdmissionWorkflowPolicy
    .find(filter)
    .sort({ admissionType: 1, version: -1 })
    .lean();

  return res.json({ success: true, data });
};

exports.evaluatePolicy = async (req, res) => {
  try {
    const policy = await AdmissionWorkflowPolicy.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req),
      active: true
    });

    if (!policy) {
      return res.status(404).json({ error: 'Admission workflow policy not found' });
    }

    const suppliedDocs = new Set((req.body.documents || []).map(String));
    const suppliedSteps = new Set((req.body.completedSteps || []).map(String));

    const missingDocuments = policy.requiredDocuments.filter(
      (x) => !suppliedDocs.has(String(x))
    );

    const missingSteps = policy.requiredSteps
      .filter((x) => x.required !== false && !suppliedSteps.has(String(x.key)))
      .map((x) => x.key);

    const hasMissing = missingDocuments.length || missingSteps.length;

    return res.status(hasMissing ? 422 : 200).json({
      success: !hasMissing,
      admissionType: policy.admissionType,
      missingDocuments,
      missingSteps
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.updateCareTeam = async (req, res) => {
  try {
    const admission = await IPDAdmission.findOne({
      _id: req.params.admissionId,
      hospitalId: hospitalId(req)
    });

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (req.body.primaryDoctorId) {
      admission.primaryDoctorId = req.body.primaryDoctorId;
    }

    if (Array.isArray(req.body.secondaryDoctorIds)) {
      admission.secondaryDoctorIds = req.body.secondaryDoctorIds;
    }

    admission.updatedBy = req.user._id;
    await admission.save({ validateBeforeSave: false });

    return res.json({ success: true, data: admission });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.notifyStakeholders = async (req, res) => {
  try {
    const admission = await IPDAdmission
      .findOne({
        _id: req.params.admissionId,
        hospitalId: hospitalId(req)
      })
      .populate('patientId');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const roles = Array.isArray(req.body.roles) && req.body.roles.length
      ? req.body.roles
      : ['floor_manager', 'admin', 'registration_desk'];

    const deliveries = [];

    for (const role of roles) {
      deliveries.push(
        await queueNotification({
          hospitalId: hospitalId(req),
          eventType: req.body.eventType || 'ipd_admission_update',
          correlationId: String(admission._id),
          recipientType: 'staff',
          recipientName: role,
          requestedChannels: ['portal'],
          priority: req.body.priority || 'normal',
          subject: req.body.subject || 'IPD admission update',
          body: req.body.message || `Patient admission ${admission.admissionNumber || admission._id} requires ${role} attention.`,
          patientId: admission.patientId?._id || admission.patientId,
          payload: {
            admissionId: admission._id,
            role
          },
          createdBy: req.user._id
        })
      );
    }

    return res.status(201).json({ success: true, data: deliveries });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.bedForecast = async (req, res) => {
  try {
    const hid = hospitalId(req);
    const hours = Number(req.query.hours || 24);

    const [
      totalBeds,
      availableBeds,
      occupiedBeds,
      expectedDischarges
    ] = await Promise.all([
      Bed.countDocuments({ hospitalId: hid }),
      Bed.countDocuments({
        hospitalId: hid,
        status: { $in: ['available', 'Available'] }
      }),
      Bed.countDocuments({
        hospitalId: hid,
        status: { $in: ['occupied', 'Occupied'] }
      }),
      IPDAdmission.countDocuments({
        hospitalId: hid,
        status: { $in: ['Admitted', 'admitted'] },
        plannedDischargeAt: {
          $lte: new Date(Date.now() + hours * 3600000)
        }
      })
    ]);

    const projectedAvailable = Math.min(totalBeds, availableBeds + expectedDischarges);

    return res.json({
      success: true,
      data: {
        totalBeds,
        availableBeds,
        occupiedBeds,
        expectedDischarges,
        projectedAvailable,
        horizonHours: hours,
        generatedAt: new Date()
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.planDischarge = async (req, res) => {
  try {
    required(req.body, ['plannedDischargeAt', 'dischargeType']);

    const admission = await IPDAdmission.findOne({
      _id: req.params.admissionId,
      hospitalId: hospitalId(req)
    });

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    admission.plannedDischargeAt = new Date(req.body.plannedDischargeAt);
    admission.plannedDischargeType = req.body.dischargeType;
    admission.plannedDischargeReason = req.body.reason;

    if (String(req.body.dischargeType).toUpperCase() === 'LAMA') {
      admission.isLAMA = true;
    }

    admission.updatedBy = req.user._id;
    await admission.save({ validateBeforeSave: false });

    return res.json({ success: true, data: admission });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.dueDischarges = async (req, res) => {
  try {
    const d = req.query.date
      ? new Date(`${req.query.date}T00:00:00.000Z`)
      : new Date();

    d.setUTCHours(0, 0, 0, 0);

    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 1);

    const data = await IPDAdmission
      .find({
        hospitalId: hospitalId(req),
        plannedDischargeAt: { $gte: d, $lt: end }
      })
      .populate('patientId', 'patientId uhid first_name last_name')
      .lean();

    return res.json({ success: true, data });
  } catch (e) {
    return sendError(res, e, 500);
  }
};