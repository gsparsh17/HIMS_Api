'use strict';

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const Vital = require('../models/Vital');
const Immunization = require('../models/Immunization');
const { requireHospitalId } = require('../services/tenantScope.service');
const { operationNow } = require('../utils/operationTimeContext');

async function ownedPatient(req) {
  const hospitalId = requireHospitalId(req);
  if (!mongoose.isValidObjectId(req.params.id)) return { hospitalId, patient: null };
  const patient = await Patient.findOne({
    _id: req.params.id,
    hospitalId,
    is_active: { $ne: false }
  }).lean();
  return { hospitalId, patient };
}

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function immunizationPayload(body = {}) {
  const occurrenceDate = body.occurrenceDate ? new Date(body.occurrenceDate) : null;
  if (!clean(body.vaccineName)) {
    const error = new Error('vaccineName is required');
    error.statusCode = 400;
    throw error;
  }
  if (!occurrenceDate || Number.isNaN(occurrenceDate.getTime())) {
    const error = new Error('occurrenceDate must be a valid date');
    error.statusCode = 400;
    throw error;
  }
  const allowedStatuses = new Set(['completed', 'entered-in-error', 'not-done']);
  const status = clean(body.status || 'completed').toLowerCase();
  if (!allowedStatuses.has(status)) {
    const error = new Error('Invalid immunization status');
    error.statusCode = 400;
    throw error;
  }
  return {
    vaccineName: clean(body.vaccineName),
    vaccineCode: clean(body.vaccineCode) || undefined,
    occurrenceDate,
    doseNumber: clean(body.doseNumber) || undefined,
    seriesDoses: clean(body.seriesDoses) || undefined,
    batchNumber: clean(body.batchNumber) || undefined,
    manufacturer: clean(body.manufacturer) || undefined,
    route: clean(body.route) || undefined,
    site: clean(body.site) || undefined,
    performerName: clean(body.performerName) || undefined,
    status,
    notes: clean(body.notes) || undefined
  };
}

exports.getPatientPreventiveCare = async (req, res) => {
  try {
    const { hospitalId, patient } = await ownedPatient(req);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const appointments = await Appointment.find({
      patient_id: patient._id,
      hospital_id: hospitalId,
      is_active: { $ne: false }
    })
      .select('_id appointment_date appointment_date_key start_time status department_id doctor_id')
      .populate('department_id', 'name department_name')
      .populate('doctor_id', 'firstName lastName')
      .sort({ appointment_date: -1, createdAt: -1 })
      .limit(50)
      .lean();

    const appointmentIds = appointments.map((row) => row._id);
    const [immunizations, vitals] = await Promise.all([
      Immunization.find({
        patientId: patient._id,
        $or: [
          { hospitalId },
          { hospitalId: { $exists: false } },
          { hospitalId: null }
        ]
      }).sort({ occurrenceDate: -1, createdAt: -1 }).lean(),
      appointmentIds.length
        ? Vital.find({ patient_id: patient._id, appointment_id: { $in: appointmentIds } }).lean()
        : []
    ]);

    const vitalByAppointment = new Map(vitals.map((row) => [String(row.appointment_id), row]));
    const wellnessAppointments = appointments.map((appointment) => ({
      ...appointment,
      vitals: vitalByAppointment.get(String(appointment._id)) || null
    }));

    return res.json({
      success: true,
      patient: { _id: patient._id, uhid: patient.uhid, patientId: patient.patientId },
      immunizations,
      wellnessAppointments
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.createPatientImmunization = async (req, res) => {
  try {
    const { hospitalId, patient } = await ownedPatient(req);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const record = await Immunization.create({
      hospitalId,
      patientId: patient._id,
      ...immunizationPayload(req.body),
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });
    return res.status(201).json({ success: true, immunization: record });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
};

exports.updatePatientImmunization = async (req, res) => {
  try {
    const { hospitalId, patient } = await ownedPatient(req);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    if (!mongoose.isValidObjectId(req.params.immunizationId)) {
      return res.status(404).json({ error: 'Immunization not found' });
    }
    const record = await Immunization.findOneAndUpdate(
      {
        _id: req.params.immunizationId,
        patientId: patient._id,
        $or: [{ hospitalId }, { hospitalId: { $exists: false } }, { hospitalId: null }]
      },
      { ...immunizationPayload(req.body), hospitalId, updatedBy: req.user?._id },
      { new: true, runValidators: true }
    );
    if (!record) return res.status(404).json({ error: 'Immunization not found' });
    return res.json({ success: true, immunization: record });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
};

exports.deletePatientImmunization = async (req, res) => {
  try {
    const { hospitalId, patient } = await ownedPatient(req);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    if (!mongoose.isValidObjectId(req.params.immunizationId)) {
      return res.status(404).json({ error: 'Immunization not found' });
    }
    const record = await Immunization.findOneAndDelete({
      _id: req.params.immunizationId,
      patientId: patient._id,
      $or: [{ hospitalId }, { hospitalId: { $exists: false } }, { hospitalId: null }]
    });
    if (!record) return res.status(404).json({ error: 'Immunization not found' });
    return res.json({ success: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};
