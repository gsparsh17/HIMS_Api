'use strict';

const EmergencyEncounter = require('../models/EmergencyEncounter');
const Patient = require('../models/Patient');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');

exports.register = async (req, res) => {
  try {
    required(req.body, ['patientId']);

    const patient = await Patient.findOne({
      _id: req.body.patientId,
      hospitalId: hospitalId(req)
    });

    if (!patient) {
      return res.status(404).json({
        error: 'Patient not found'
      });
    }

    const previous = await EmergencyEncounter
      .findOne({
        hospitalId: hospitalId(req),
        patientId: patient._id
      })
      .sort({ arrivalAt: -1 });

    const row = await EmergencyEncounter.create({
      hospitalId: hospitalId(req),
      emergencyNumber: req.body.emergencyNumber || ref('ER'),
      patientId: patient._id,
      readmissionReference: req.body.readmission ? previous?._id : undefined,
      arrivalAt: req.body.arrivalAt || new Date(),
      triage: {
        category: req.body.triage?.category || 'yellow',
        chiefComplaint: req.body.triage?.chiefComplaint,
        vitals: req.body.triage?.vitals,
        triagedBy: req.user._id,
        triagedAt: new Date()
      },
      status: 'triaged',
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row,
      existingPatient: {
        _id: patient._id,
        uhid: patient.uhid,
        first_name: patient.first_name,
        last_name: patient.last_name
      }
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.get = async (req, res) => {
  const row = await EmergencyEncounter
    .findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    })
    .populate('patientId', 'patientId uhid first_name last_name medical_history allergies blood_group')
    .lean();

  if (!row) {
    return res.status(404).json({
      error: 'Emergency encounter not found'
    });
  }

  return res.json({
    success: true,
    data: row
  });
};

exports.markMlc = async (req, res) => {
  try {
    required(req.body, ['caseNumber']);

    const row = await EmergencyEncounter.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Emergency encounter not found'
      });
    }

    row.medicoLegal = {
      isMlc: true,
      caseNumber: req.body.caseNumber,
      policeStation: req.body.policeStation,
      policeInformedAt: req.body.policeInformedAt || new Date(),
      notes: req.body.notes
    };

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

exports.ambulanceHandoff = async (req, res) => {
  try {
    required(req.body, ['ambulanceNumber', 'preHospitalSummary']);

    const row = await EmergencyEncounter.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Emergency encounter not found'
      });
    }

    row.ambulanceHandoff = {
      ambulanceNumber: req.body.ambulanceNumber,
      agency: req.body.agency,
      paramedicName: req.body.paramedicName,
      preHospitalSummary: req.body.preHospitalSummary,
      treatmentGiven: req.body.treatmentGiven,
      vitals: req.body.vitals || {},
      deviceReference: req.body.deviceReference,
      handoffAt: req.body.handoffAt || new Date(),
      receivedBy: req.user._id
    };

    row.updatedBy = req.user._id;
    await row.save();

    await queueNotification({
      hospitalId: hospitalId(req),
      eventType: 'ambulance_handoff_received',
      correlationId: String(row._id),
      recipientType: 'staff',
      requestedChannels: ['portal'],
      priority: 'high',
      subject: 'Emergency ambulance handoff',
      body: req.body.preHospitalSummary,
      patientId: row.patientId,
      payload: {
        emergencyEncounterId: row._id,
        ambulanceNumber: req.body.ambulanceNumber
      },
      createdBy: req.user._id
    });

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.activateCode = async (req, res) => {
  try {
    required(req.body, ['codeType']);

    const row = await EmergencyEncounter.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Emergency encounter not found'
      });
    }

    row.codeActivations.push({
      codeType: req.body.codeType,
      activatedBy: req.user._id,
      notes: req.body.notes
    });

    row.updatedBy = req.user._id;
    await row.save();

    const notification = await queueNotification({
      hospitalId: hospitalId(req),
      eventType: 'emergency_code_activation',
      correlationId: String(row._id),
      recipientType: 'staff',
      requestedChannels: ['portal'],
      priority: 'critical',
      subject: `Emergency ${req.body.codeType} activated`,
      body: req.body.notes || `Respond to ${req.body.codeType}`,
      patientId: row.patientId,
      payload: {
        emergencyEncounterId: row._id,
        codeType: req.body.codeType
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

exports.respondCode = async (req, res) => {
  try {
    required(req.body, ['activationId', 'action']);

    const row = await EmergencyEncounter.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Emergency encounter not found'
      });
    }

    const activation = row.codeActivations.id(req.body.activationId);

    if (!activation) {
      return res.status(404).json({
        error: 'Code activation not found'
      });
    }

    activation.responses = activation.responses || [];
    activation.responses.push({
      responderId: req.user._id,
      respondedAt: new Date(),
      action: req.body.action,
      note: req.body.note
    });

    if (req.body.close === true) {
      activation.closedAt = new Date();
    }

    row.updatedBy = req.user._id;
    await row.save();

    return res.json({
      success: true,
      data: activation
    });
  } catch (e) {
    return sendError(res, e);
  }
};