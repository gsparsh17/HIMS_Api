'use strict';

const EmergencyEncounter = require('../models/EmergencyEncounter');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');

exports.register = async (req, res) => {
  try {
    required(req.body, ['patientId']);

    const hid = hospitalId(req);
    const patient = await Patient.findOne({
      _id: req.body.patientId,
      hospitalId: hid
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    let appointment;
    let admission;

    if (req.body.appointmentId) {
      appointment = await Appointment.findOne({
        _id: req.body.appointmentId,
        hospital_id: hid,
        patient_id: patient._id
      });

      if (!appointment) {
        return res.status(400).json({ error: 'Front-desk appointment does not belong to this patient/hospital' });
      }
    }

    if (req.body.admissionId) {
      admission = await IPDAdmission.findOne({
        _id: req.body.admissionId,
        hospitalId: hid,
        patientId: patient._id
      });

      if (!admission) {
        return res.status(400).json({ error: 'Front-desk admission does not belong to this patient/hospital' });
      }
    }

    if (appointment || admission) {
      const existing = await EmergencyEncounter.findOne({
        hospitalId: hid,
        ...(appointment ? { appointmentId: appointment._id } : { admissionId: admission._id })
      });

      if (existing) {
        return res.json({
          success: true,
          data: existing,
          existing: true,
          existingPatient: {
            _id: patient._id,
            uhid: patient.uhid,
            first_name: patient.first_name,
            last_name: patient.last_name
          }
        });
      }
    }

    const previous = await EmergencyEncounter
      .findOne({ hospitalId: hid, patientId: patient._id })
      .sort({ arrivalAt: -1 });

    const medicoLegal = req.body.medicoLegal?.isMlc
      ? {
          isMlc: true,
          caseNumber: req.body.medicoLegal.caseNumber,
          policeStation: req.body.medicoLegal.policeStation,
          policeInformedAt: req.body.medicoLegal.policeInformedAt || new Date(),
          notes: req.body.medicoLegal.notes
        }
      : { isMlc: false };

    if (medicoLegal.isMlc && !medicoLegal.caseNumber) {
      return res.status(400).json({ error: 'MLC case number is required when medico-legal case is enabled' });
    }

    let ambulanceHandoff;
    if (req.body.ambulanceHandoff) {
      required(req.body.ambulanceHandoff, ['ambulanceNumber', 'preHospitalSummary']);
      ambulanceHandoff = {
        ambulanceNumber: req.body.ambulanceHandoff.ambulanceNumber,
        agency: req.body.ambulanceHandoff.agency,
        paramedicName: req.body.ambulanceHandoff.paramedicName,
        preHospitalSummary: req.body.ambulanceHandoff.preHospitalSummary,
        treatmentGiven: req.body.ambulanceHandoff.treatmentGiven,
        vitals: req.body.ambulanceHandoff.vitals || {},
        deviceReference: req.body.ambulanceHandoff.deviceReference,
        handoffAt: req.body.ambulanceHandoff.handoffAt || new Date(),
        receivedBy: req.user._id
      };
    }

    const row = await EmergencyEncounter.create({
      hospitalId: hid,
      emergencyNumber: req.body.emergencyNumber || ref('ER'),
      patientId: patient._id,
      appointmentId: appointment?._id,
      admissionId: admission?._id,
      source: appointment || admission ? 'front_desk' : 'standalone',
      readmissionReference: req.body.readmission ? previous?._id : undefined,
      arrivalAt: req.body.arrivalAt || new Date(),
      triage: {
        category: req.body.triage?.category || 'yellow',
        chiefComplaint: req.body.triage?.chiefComplaint,
        vitals: req.body.triage?.vitals,
        triagedBy: req.user._id,
        triagedAt: new Date()
      },
      medicoLegal,
      ambulanceHandoff,
      status: 'triaged',
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    if (ambulanceHandoff) {
      await queueNotification({
        hospitalId: hid,
        eventType: 'ambulance_handoff_received',
        correlationId: String(row._id),
        recipientType: 'staff',
        requestedChannels: ['portal'],
        priority: 'high',
        subject: 'Emergency ambulance handoff',
        body: ambulanceHandoff.preHospitalSummary,
        patientId: row.patientId,
        payload: {
          emergencyEncounterId: row._id,
          ambulanceNumber: ambulanceHandoff.ambulanceNumber
        },
        createdBy: req.user._id
      });
    }

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