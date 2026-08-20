const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');
const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Episode = require('../models/Episode');
const Hospital = require('../models/Hospital');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const { calculatePartTimeSalary } = require('../controllers/salary.controller');
const { requireHospitalId } = require('../services/tenantScope.service');
const { nextAppointmentToken } = require('../utils/appointmentNumber');
const { queueNotification } = require('../services/nabhNotification.service');
const { assertPatientReadyForContext } = require('../services/patientRegistration.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { createEncounterCoverage } = require('../services/coverage.service');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const HRStaffProfile = require('../models/HRStaffProfile');
const StaffAvailability = require('../models/StaffAvailability');
const { rememberDeclaredPreference } = require('../services/patientCoveragePreference.service');
const { resolveFinancialPolicy } = require('../services/financialPolicy.service');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalDateKey,
  hospitalTodayKey,
  hospitalDayBounds,
  dateKeyToStorageDate,
  parseHospitalDateTime,
  assertInstantOnHospitalDate,
  calendarDayKey,
  canonicalBookingFingerprint
} = require('../utils/hospitalDateTime');


function appointmentDaySelector(dateKey, timeZone = DEFAULT_HOSPITAL_TIME_ZONE) {
  const key = hospitalDateKey(dateKey, timeZone);
  const { start, end } = hospitalDayBounds(key, timeZone);
  return {
    $or: [
      { appointment_date_key: key },
      { appointment_date: { $gte: start, $lt: end } }
    ]
  };
}
async function notifyAppointment(appointmentOrId, eventType, userId, extra = {}, hospitalId = null) {
  const appointment = typeof appointmentOrId === 'string'
    ? await Appointment.findOne({
      _id: appointmentOrId,
      ...(hospitalId ? { hospital_id: hospitalId } : {})
    })
      .populate('patient_id', 'first_name last_name phone email uhid patientId')
      .populate('doctor_id', 'firstName lastName phone email')
    : await appointmentOrId.populate([
      { path: 'patient_id', select: 'first_name last_name phone email uhid patientId' },
      { path: 'doctor_id', select: 'firstName lastName phone email' }
    ]);
  if (!appointment) return null;
  const patient = appointment.patient_id;
  const doctor = appointment.doctor_id;
  const date = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE);
  const mode = appointment.visit_mode || 'physical';
  const delivery = await queueNotification({
    hospitalId: appointment.hospital_id,
    eventType,
    correlationId: String(appointment._id),
    recipientType: 'patient',
    recipientId: patient?._id,
    recipientName: [patient?.first_name, patient?.last_name].filter(Boolean).join(' '),
    contact: { email: patient?.email, phone: patient?.phone },
    requestedChannels: ['portal', ...(patient?.phone ? ['sms'] : [])],
    subject: extra.subject || `Appointment ${eventType.replaceAll('_', ' ')}`,
    body: extra.body || `Your ${mode} appointment with Dr. ${[doctor?.firstName, doctor?.lastName].filter(Boolean).join(' ')} is scheduled for ${date}.`,
    payload: {
      appointmentId: appointment._id,
      visitMode: mode,
      status: appointment.status,
      meetingUrl: appointment.teleconsultation?.meetingUrl,
      ...extra.payload
    },
    priority: appointment.priority === 'Urgent' ? 'high' : 'normal',
    createdBy: userId
  });
  await Appointment.updateOne(
    { _id: appointment._id, hospital_id: appointment.hospital_id },
    { $addToSet: { notificationDeliveryIds: delivery._id } }
  );
  return delivery;
}

function startRoleAllowed(user) {
  return ['admin', 'mediqliq_super_admin', 'doctor'].includes(String(user?.role || '').toLowerCase());
}

async function guardConsultationStart({ hospitalId, appointment, doctorId, user }) {
  if (!startRoleAllowed(user)) {
    const error = new Error('Only the assigned doctor or an administrator may start a consultation');
    error.statusCode = 403;
    error.code = 'CONSULTATION_START_FORBIDDEN';
    throw error;
  }
  const resolvedDoctorId = doctorId || appointment.doctor_id;
  const [patient, doctor, activeOther, profile] = await Promise.all([
    Patient.findOne({ _id: appointment.patient_id, hospitalId, is_active: { $ne: false } }).select('_id patientId uhid').lean(),
    Doctor.findOne({ _id: resolvedDoctorId, hospitalId, is_active: { $ne: false } }).select('_id user_id firstName lastName').lean(),
    Appointment.findOne({
      hospital_id: hospitalId,
      doctor_id: resolvedDoctorId,
      status: 'In Progress',
      _id: { $ne: appointment._id }
    }).select('_id patient_id actual_start_time').lean(),
    HRStaffProfile.findOne({
      hospital_id: hospitalId,
      $or: [{ doctor_id: resolvedDoctorId }, { source_model: 'Doctor', source_id: resolvedDoctorId }]
    }).select('_id availability_status availability_note').lean()
  ]);
  if (!patient) {
    const error = new Error('Appointment patient is not mapped to this hospital');
    error.statusCode = 409;
    error.code = 'APPOINTMENT_PATIENT_MAPPING_INVALID';
    throw error;
  }
  if (!doctor) {
    const error = new Error('Appointment doctor is not mapped to this hospital');
    error.statusCode = 409;
    error.code = 'APPOINTMENT_DOCTOR_MAPPING_INVALID';
    throw error;
  }
  if (String(user?.role || '').toLowerCase() === 'doctor' && doctor.user_id && String(doctor.user_id) !== String(user?._id)) {
    const error = new Error('Doctors may start only their own assigned appointments');
    error.statusCode = 403;
    error.code = 'APPOINTMENT_DOCTOR_MISMATCH';
    throw error;
  }
  const blocked = new Set(['on_leave', 'off_duty', 'unavailable', 'in_ot']);
  if (profile && blocked.has(String(profile.availability_status || '').toLowerCase())) {
    const error = new Error(`Doctor is currently ${String(profile.availability_status).replaceAll('_', ' ')}`);
    error.statusCode = 409;
    error.code = 'DOCTOR_UNAVAILABLE';
    error.details = { availability: profile.availability_status, note: profile.availability_note || '' };
    throw error;
  }
  if (activeOther) {
    const error = new Error('Doctor already has an active consultation');
    error.statusCode = 409;
    error.code = 'DOCTOR_ALREADY_IN_CONSULTATION';
    error.details = { activeAppointmentId: activeOther._id };
    throw error;
  }
  return { doctor, profile };
}

async function setDoctorOpdAvailability({ hospitalId, doctorId, status, userId, note }) {
  const profile = await HRStaffProfile.findOne({
    hospital_id: hospitalId,
    $or: [{ doctor_id: doctorId }, { source_model: 'Doctor', source_id: doctorId }]
  });
  if (!profile) return null;
  profile.availability_status = status;
  profile.availability_note = note || profile.availability_note;
  await profile.save();
  await StaffAvailability.create({
    employee_id: profile._id,
    user_id: profile.user_id,
    status,
    current_location: status === 'in_opd' ? 'OPD' : undefined,
    valid_from: operationNow(),
    note,
    hospital_id: hospitalId,
    updated_by: userId
  });
  return profile;
}

async function recalculateQueue({ hospitalId, departmentId, date, timeZone = DEFAULT_HOSPITAL_TIME_ZONE }) {
  let dateKey;
  try {
    dateKey = hospitalDateKey(date, timeZone);
  } catch (_error) {
    return [];
  }
  const { start, end } = hospitalDayBounds(dateKey, timeZone);
  const rows = await Appointment.find({
    hospital_id: hospitalId,
    department_id: departmentId,
    status: { $in: ['Scheduled', 'In Progress'] },
    is_active: { $ne: false },
    $or: [
      { appointment_date_key: dateKey },
      { appointment_date: { $gte: start, $lt: end } }
    ]
  });
  const priorityWeight = { Urgent: 4, High: 3, Normal: 2, Low: 1 };
  rows.sort((left, right) => {
    const priorityDifference = (priorityWeight[right.priority] || 0) - (priorityWeight[left.priority] || 0);
    if (priorityDifference) return priorityDifference;
    const leftStart = left.start_time ? new Date(left.start_time).getTime() : Number.MAX_SAFE_INTEGER;
    const rightStart = right.start_time ? new Date(right.start_time).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftStart !== rightStart) return leftStart - rightStart;
    const serialDifference = Number(left.serial_number || Number.MAX_SAFE_INTEGER) - Number(right.serial_number || Number.MAX_SAFE_INTEGER);
    if (serialDifference) return serialDifference;
    return new Date(left.created_at || left.createdAt || 0) - new Date(right.created_at || right.createdAt || 0);
  });
  const writes = [];
  rows.forEach((row, index) => {
    const averageDuration = Number(row.duration || 10);
    row.queuePosition = index + 1;
    row.estimatedWaitMinutes = rows
      .slice(0, index)
      .reduce((sum, previous) => sum + Number(previous.duration || averageDuration), 0);
    writes.push(row.save());
  });
  await Promise.all(writes);
  return rows;
}

// Add this function to handle episode linking during appointment creation
exports.linkAppointmentToEpisodeSuggestion = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { appointmentId, episodeId } = req.body;

    const current = await Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId });
    if (!current) return res.status(404).json({ error: 'Appointment not found' });
    if (!mongoose.isValidObjectId(episodeId)) {
      return res.status(400).json({ error: 'Invalid episodeId' });
    }
    const episode = await Episode.findOne({ _id: episodeId, patientId: current.patient_id });
    if (!episode) {
      return res.status(404).json({ error: 'Episode not found for the appointment patient' });
    }
    current.episodeId = episode._id;
    await current.save();
    const appointment = current;

    res.json({
      success: true,
      message: 'Appointment linked to episode',
      appointment
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// ========== HELPER FUNCTIONS ==========
function hasTimeConflict(appointments, startTime, endTime, breaks = []) {
  for (const appt of appointments) {
    if ((startTime >= appt.startTime && startTime < appt.endTime) ||
      (endTime > appt.startTime && endTime <= appt.endTime) ||
      (startTime <= appt.startTime && endTime >= appt.endTime)) {
      return true;
    }
  }
  for (const brk of breaks) {
    if ((startTime >= brk.startTime && startTime < brk.endTime) ||
      (endTime > brk.startTime && endTime <= brk.endTime) ||
      (startTime <= brk.startTime && endTime >= brk.endTime)) {
      return true;
    }
  }
  return false;
}

async function removeAppointmentFromCalendar(appointment) {
  const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
  if (!calendar) return;

  const timeZone = calendar.timezone || appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const dateStr = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone);
  const day = calendar.days.find((row) => calendarDayKey(row, timeZone) === dateStr);
  if (!day) return;

  const doctor = day.doctors.find((row) => String(row.doctorId) === String(appointment.doctor_id));
  if (!doctor) return;

  if (appointment.type === 'time-based') {
    doctor.bookedAppointments = doctor.bookedAppointments.filter(
      (row) => String(row.appointmentId) !== String(appointment._id)
    );
  } else {
    doctor.bookedPatients = doctor.bookedPatients.filter(
      (row) => String(row.appointmentId) !== String(appointment._id)
    );
  }

  await calendar.save();
}

async function updateCalendarAppointmentStatus(appointment, status) {
  const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
  if (!calendar) return false;
  const timeZone = calendar.timezone || appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const dateKey = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone);
  const day = calendar.days.find((row) => calendarDayKey(row, timeZone) === dateKey);
  const doctorDay = day?.doctors?.find(
    (row) => String(row.doctorId) === String(appointment.doctor_id)
  );
  if (!doctorDay) return false;
  const normalized = status === 'In Progress' ? 'InProgress' : status;
  const calendarAppointment = doctorDay.bookedAppointments?.find(
    (row) => String(row.appointmentId) === String(appointment._id)
  );
  if (calendarAppointment) calendarAppointment.status = normalized;
  await calendar.save();
  return Boolean(calendarAppointment);
}


// ========== OFFLINE SYNC METHODS ==========

// Check appointment conflict (for offline pre-check)
exports.checkAppointmentConflict = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { doctorId, appointmentDate, startTime, duration = 10 } = req.query;
    if (!doctorId || !appointmentDate) {
      return res.status(400).json({ error: 'doctorId and appointmentDate are required' });
    }
    let dateStr;
    try {
      dateStr = hospitalDateKey(appointmentDate, DEFAULT_HOSPITAL_TIME_ZONE);
    } catch (_error) {
      return res.status(400).json({ error: 'Invalid appointmentDate' });
    }
    if (!mongoose.isValidObjectId(doctorId)
      || !(await Doctor.exists({ _id: doctorId, hospitalId, is_active: { $ne: false } }))) {
      return res.status(404).json({ error: 'Doctor not found for this hospital' });
    }
    const durationMinutes = Number(duration);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440) {
      return res.status(400).json({ error: 'duration must be between 1 and 1440 minutes' });
    }

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) {
      return res.json({ hasConflict: false, message: 'No calendar found' });
    }

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    dateStr = hospitalDateKey(appointmentDate, timeZone);
    const day = calendar.days.find((d) => calendarDayKey(d, timeZone) === dateStr);

    if (!day) {
      return res.json({ hasConflict: false, message: 'No schedule for this date' });
    }

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
    if (!doctor) {
      return res.json({ hasConflict: false, message: 'Doctor not scheduled for this date' });
    }

    if (startTime) {
      let start;
      try {
        start = parseHospitalDateTime(startTime, dateStr, timeZone);
        assertInstantOnHospitalDate(start, dateStr, timeZone);
      } catch (error) {
        return res.status(400).json({ error: error.message, code: error.code || 'VALIDATION_ERROR' });
      }
      const end = new Date(start.getTime() + durationMinutes * 60000);

      const hasConflict = doctor.bookedAppointments.some(appt => {
        const apptStart = new Date(appt.startTime);
        const apptEnd = new Date(appt.endTime);
        return (start < apptEnd && end > apptStart);
      });

      return res.json({
        hasConflict,
        message: hasConflict ? 'Time slot is already booked' : 'Time slot is available'
      });
    }

    res.json({ hasConflict: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointment by temp ID (for offline resolution)
exports.getAppointmentByTempId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { tempId } = req.params;

    const queueItem = await OfflineSyncLog.findOne({
      hospitalId,
      tempAppointmentId: tempId,
      entityType: 'APPOINTMENT',
      status: 'SYNCED'
    });

    if (queueItem && queueItem.serverId) {
      const appointment = await Appointment.findOne({ _id: queueItem.serverId, hospital_id: hospitalId })
        .populate('patient_id')
        .populate('doctor_id')
        .populate('department_id')
        .populate('hospital_id');

      if (appointment) {
        return res.json({ appointment });
      }
    }

    // Also check by localId
    const syncLog = await OfflineSyncLog.findOne({
      hospitalId,
      localId: tempId,
      entityType: 'APPOINTMENT',
      status: 'SYNCED'
    });

    if (syncLog && syncLog.serverId) {
      const appointment = await Appointment.findOne({ _id: syncLog.serverId, hospital_id: hospitalId })
        .populate('patient_id')
        .populate('doctor_id')
        .populate('department_id')
        .populate('hospital_id');

      if (appointment) {
        return res.json({ appointment });
      }
    }

    res.json({ appointment: null });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Bulk Create Appointments (Enhanced for offline sync)
exports.bulkCreateAppointments = async (req, res) => {
  const appointmentsData = req.body;

  if (!appointmentsData || !Array.isArray(appointmentsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }
  if (appointmentsData.length > 500) {
    return res.status(413).json({ error: 'A maximum of 500 appointments can be synchronized in one request.' });
  }

  const successfulImports = [];
  const failedImports = [];
  const syncLogs = [];
  const calendarUpdates = new Map();

  const hospitalId = requireHospitalId(req);
  const hospital = await Hospital.findById(hospitalId);
  if (!hospital) {
    return res.status(404).json({ error: 'Hospital not found.' });
  }

  const timeZone = hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const todayKey = hospitalTodayKey(timeZone);

  for (const appointmentData of appointmentsData) {
    let calendarMutation = null;
    let appointmentSaved = false;
    try {
      if (!appointmentData || typeof appointmentData !== 'object') {
        failedImports.push({ reason: 'Appointment row must be an object.' });
        continue;
      }
      // Get patient server ID - Enhanced lookup logic
      let patientId = null;
      let patientRecord = null;
      const suppliedPatientIdentifier = appointmentData.patient_id == null
        ? ''
        : String(appointmentData.patient_id).trim();

      // Strategy 1: Check if patient_id is already a MongoDB ObjectId
      if (/^[0-9a-fA-F]{24}$/.test(suppliedPatientIdentifier)) {
        const patient = await Patient.findOne({ _id: suppliedPatientIdentifier, hospitalId });
        if (patient) {
          patientRecord = patient;
          patientId = patient._id;
        }
      }

      // Strategy 2: Lookup by patientLocalId mapping from OfflineSyncLog
      if (!patientId && appointmentData.patientLocalId) {
        const syncLog = await OfflineSyncLog.findOne({
          localId: appointmentData.patientLocalId,
          hospitalId,
          entityType: 'PATIENT',
          status: 'SYNCED'
        });

        if (syncLog && syncLog.serverId) {
          patientId = syncLog.serverId;
        }
      }

      // Strategy 3: Lookup by phone number
      if (!patientId && appointmentData.phone) {
        const patient = await Patient.findOne({ hospitalId, phone: appointmentData.phone });
        if (patient) {
          patientRecord = patient;
          patientId = patient._id;
        }
      }

      // Strategy 4: Lookup by patientId (UHID) - THIS IS THE KEY FIX
      if (!patientId && suppliedPatientIdentifier) {
        const patient = await Patient.findOne({
          hospitalId,
          $or: [
            { patientId: suppliedPatientIdentifier },
            { uhid: suppliedPatientIdentifier }
          ]
        });
        if (patient) {
          patientId = patient._id;
          console.log(`Found patient by patientId/uhid: ${suppliedPatientIdentifier} -> ${patientId}`);
        }
      }

      // Strategy 5: Lookup by any other identifier in the appointment data
      if (!patientId && appointmentData.uhid) {
        const patient = await Patient.findOne({ hospitalId, uhid: appointmentData.uhid });
        if (patient) {
          patientRecord = patient;
          patientId = patient._id;
        }
      }

      // Patient registration has its own mandatory-field, duplicate and OTP
      // controls. Never create a placeholder patient from appointment sync.
      if (!patientId && appointmentData.shouldCreatePatient) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: 'Synchronize the patient registration first; appointment sync cannot create placeholder patients.'
        });
        continue;
      }

      if (!patientId) {
        failedImports.push({
          localId: appointmentData.localId,
          patientId: appointmentData.patient_id,
          patientLocalId: appointmentData.patientLocalId,
          phone: appointmentData.phone,
          reason: `Patient not found. Searched by: patient_id=${appointmentData.patient_id}, patientLocalId=${appointmentData.patientLocalId}, phone=${appointmentData.phone}`
        });
        continue;
      }
      if (!patientRecord) {
        patientRecord = await Patient.findOne({ _id: patientId, hospitalId }); // eslint-disable-line no-await-in-loop
        if (!patientRecord) {
          failedImports.push({ localId: appointmentData.localId, reason: 'Mapped patient is not available in this hospital.' });
          continue;
        }
      }

      // Get doctor
      if (!mongoose.isValidObjectId(appointmentData.doctor_id)) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: 'A valid doctor_id is required.'
        });
        continue;
      }
      const doctor = await Doctor.findOne({ _id: appointmentData.doctor_id, hospitalId });
      if (!doctor) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: `Doctor not found: ${appointmentData.doctor_id}`
        });
        continue;
      }

      // Get department
      let departmentId = appointmentData.department_id;
      if (!departmentId && doctor.department) {
        departmentId = doctor.department;
      }
      if (!mongoose.isValidObjectId(departmentId)
        || !(await Department.exists({ _id: departmentId, hospitalId }))) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: `Department not found: ${departmentId || 'missing'}`
        });
        continue;
      }

      // appointment_date is a semantic hospital-local calendar day, not a UTC instant.
      let appointmentDateKey;
      try {
        appointmentDateKey = hospitalDateKey(appointmentData.appointment_date, timeZone);
      } catch (_error) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: 'Invalid appointment_date.'
        });
        continue;
      }
      const appointmentDate = dateKeyToStorageDate(appointmentDateKey);
      const isHistorical = appointmentDateKey < todayKey;

      const effectiveIdempotencyKey = appointmentData.idempotencyKey || appointmentData.localId || undefined;
      if (effectiveIdempotencyKey) {
        const existing = await Appointment.findOne({ // eslint-disable-line no-await-in-loop
          hospital_id: hospitalId,
          idempotencyKey: effectiveIdempotencyKey
        });
        if (existing) {
          successfulImports.push({
            localId: appointmentData.localId,
            serverId: existing._id,
            token: existing.token,
            serialNumber: existing.serial_number,
            patientId,
            patientIdentifier: appointmentData.patient_id,
            duplicate: true
          });
          continue;
        }
      }

      const visitMode = appointmentData.visit_mode || appointmentData.visitMode || 'physical';
      if (!['physical', 'teleconsultation', 'homecare'].includes(visitMode)) {
        failedImports.push({ localId: appointmentData.localId, reason: 'Invalid visit mode.' });
        continue;
      }
      if (visitMode === 'teleconsultation' && !appointmentData.teleconsultation?.consentCaptured) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: 'Teleconsultation consent must be captured before booking.'
        });
        continue;
      }
      const appointmentType = appointmentData.type || 'time-based';
      if (!['time-based', 'number-based'].includes(appointmentType)) {
        failedImports.push({ localId: appointmentData.localId, reason: 'Invalid appointment type.' });
        continue;
      }
      const durationMinutes = Number(appointmentData.duration ?? 10);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440) {
        failedImports.push({ localId: appointmentData.localId, reason: 'duration must be between 1 and 1440 minutes.' });
        continue;
      }
      const requestedStatus = appointmentData.status || 'Scheduled';
      if (!['Scheduled', 'In Progress', 'Completed', 'Cancelled'].includes(requestedStatus)) {
        failedImports.push({ localId: appointmentData.localId, reason: 'Invalid appointment status.' });
        continue;
      }
      if (!isHistorical && !['Scheduled', 'In Progress'].includes(requestedStatus)) {
        failedImports.push({
          localId: appointmentData.localId,
          reason: 'Future appointments must be Scheduled or In Progress; completed/cancelled rows are historical records.'
        });
        continue;
      }
      const appointment = new Appointment({
        patient_id: patientId,
        doctor_id: appointmentData.doctor_id,
        hospital_id: hospital._id,
        department_id: departmentId,
        appointment_date: appointmentDate,
        appointment_date_key: appointmentDateKey,
        scheduled_timezone: timeZone,
        type: appointmentType,
        appointment_type: appointmentData.appointment_type || 'consultation',
        priority: appointmentData.priority || 'Normal',
        notes: appointmentData.notes || '',
        duration: durationMinutes,
        status: requestedStatus,
        visit_mode: visitMode,
        teleconsultation: {
          communicationMode: visitMode === 'teleconsultation'
            ? (appointmentData.teleconsultation?.communicationMode || 'video')
            : 'not_applicable',
          meetingUrl: appointmentData.teleconsultation?.meetingUrl,
          meetingReference: appointmentData.teleconsultation?.meetingReference,
          consentCaptured: Boolean(appointmentData.teleconsultation?.consentCaptured),
          consentCapturedAt: appointmentData.teleconsultation?.consentCaptured
            ? (appointmentData.teleconsultation?.consentCapturedAt || operationNow())
            : undefined,
          consentCapturedBy: appointmentData.teleconsultation?.consentCaptured
            ? req.user?._id
            : undefined
        },
        attachments: Array.isArray(appointmentData.attachments)
          ? appointmentData.attachments.slice(0, 20).map((item) => ({
            name: item?.name,
            url: item?.url,
            mimeType: item?.mimeType,
            addedAt: operationNow(),
            addedBy: req.user?._id
          }))
          : [],
        externalBooking: appointmentData.externalBooking?.system
          && appointmentData.externalBooking?.externalAppointmentId
          ? {
            system: appointmentData.externalBooking.system,
            externalAppointmentId: appointmentData.externalBooking.externalAppointmentId,
            sourceUpdatedAt: appointmentData.externalBooking.sourceUpdatedAt,
            lastSyncedAt: new Date(),
            rawPayload: appointmentData.externalBooking.rawPayload
          }
          : undefined,
        idempotencyKey: effectiveIdempotencyKey,
        submissionSource: appointmentData.submissionSource || 'OFFLINE_SYNC',
        bookedBy: req.user?._id,
        lifecycleTimestamps: {
          bookedAt: appointmentData.lifecycleTimestamps?.bookedAt
            || appointmentData.offlineCapturedAt
            || operationNow(),
          checkedInAt: appointmentData.lifecycleTimestamps?.checkedInAt,
          consultationStartedAt: appointmentData.lifecycleTimestamps?.consultationStartedAt,
          consultationEndedAt: appointmentData.lifecycleTimestamps?.consultationEndedAt,
          cancelledAt: appointmentData.lifecycleTimestamps?.cancelledAt
        },
        actual_start_time: appointmentData.actual_start_time,
        actual_end_time: appointmentData.actual_end_time,
        cancellationReason: requestedStatus === 'Cancelled'
          ? String(appointmentData.cancellationReason || 'Imported historical cancellation')
          : undefined,
        cancelledAt: requestedStatus === 'Cancelled'
          ? (appointmentData.cancelledAt || appointmentData.lifecycleTimestamps?.cancelledAt || operationNow())
          : undefined,
        cancelledBy: requestedStatus === 'Cancelled' ? req.user?._id : undefined
      });

      // Handle calendar for future appointments
      if (!isHistorical) {
        // A Calendar document stores all dates for a hospital. Keep one shared
        // in-memory instance so updates for different dates cannot overwrite
        // each other when the batch is persisted.
        const cacheKey = String(hospital._id);
        let calendar = calendarUpdates.get(cacheKey);

        if (!calendar) {
          calendar = await Calendar.findOne({ hospitalId: hospital._id });
          if (!calendar) {
            failedImports.push({ localId: appointmentData.localId, reason: 'Hospital calendar is not configured.' });
            continue;
          }
          calendarUpdates.set(cacheKey, calendar);
        }

        const calendarTimeZone = calendar.timezone || timeZone;
        const day = calendar.days.find((d) => calendarDayKey(d, calendarTimeZone) === appointmentDateKey);
        if (!day) {
          failedImports.push({ localId: appointmentData.localId, reason: 'Appointment date is not available in the hospital calendar.' });
          continue;
        }

        const docDay = day.doctors.find(d => d.doctorId.toString() === doctor._id.toString());
        if (!docDay) {
          failedImports.push({ localId: appointmentData.localId, reason: 'Doctor is not scheduled on the appointment date.' });
          continue;
        }

        if (appointment.type === 'time-based') {
          if (!appointmentData.start_time) {
            failedImports.push({ localId: appointmentData.localId, reason: 'start_time is required for time-based appointments.' });
            continue;
          }
          let startTime;
          try {
            startTime = parseHospitalDateTime(appointmentData.start_time, appointmentDateKey, timeZone);
            assertInstantOnHospitalDate(startTime, appointmentDateKey, timeZone);
          } catch (_error) {
            failedImports.push({ localId: appointmentData.localId, reason: 'Invalid start_time or date/time mismatch.' });
            continue;
          }
          const endTime = new Date(startTime.getTime() + appointment.duration * 60000);

          if (hasTimeConflict(docDay.bookedAppointments, startTime, endTime, docDay.breaks)) {
            failedImports.push({
              localId: appointmentData.localId,
              reason: 'Time slot conflict'
            });
            continue;
          }

          appointment.start_time = startTime;
          appointment.end_time = endTime;

          docDay.bookedAppointments.push({
            startTime,
            endTime,
            duration: appointment.duration,
            appointmentId: appointment._id,
            status: appointment.status === 'In Progress' ? 'InProgress' : appointment.status
          });
          calendarMutation = { docDay, type: 'time-based', appointmentId: appointment._id };
        } else if (appointment.type === 'number-based') {
          const lastPatient = docDay.bookedPatients.sort((a, b) => b.serialNumber - a.serialNumber)[0];
          const serialNumber = lastPatient ? lastPatient.serialNumber + 1 : 1;
          appointment.serial_number = serialNumber;

          docDay.bookedPatients.push({
            patientId: appointment.patient_id,
            serialNumber,
            appointmentId: appointment._id
          });
          calendarMutation = { docDay, type: 'number-based', appointmentId: appointment._id };
        }
      } else {
        // Historical appointment - set times if provided
        if (appointment.type === 'time-based' && appointmentData.start_time) {
          let startTime;
          try {
            startTime = parseHospitalDateTime(appointmentData.start_time, appointmentDateKey, timeZone);
            assertInstantOnHospitalDate(startTime, appointmentDateKey, timeZone);
          } catch (_error) {
            failedImports.push({ localId: appointmentData.localId, reason: 'Invalid start_time or date/time mismatch.' });
            continue;
          }
          appointment.start_time = startTime;
          appointment.end_time = new Date(startTime.getTime() + appointment.duration * 60000);
        }
        if (appointment.type === 'number-based' && appointmentData.serial_number) {
          appointment.serial_number = parseInt(appointmentData.serial_number);
        }
      }

      appointment.bookingFingerprint = canonicalBookingFingerprint({
        hospitalId,
        patientId: patientId,
        doctorId: appointmentData.doctor_id,
        appointmentDateKey,
        type: appointment.type,
        startTime: appointment.start_time
      });

      appointment.token = await nextAppointmentToken({
        hospitalId,
        patientType: patientRecord.patient_type || 'opd',
        appointmentDate,
        appointmentDateKey,
        timeZone
      });
      await appointment.save();
      appointmentSaved = true;

      try {
        const coverageProvided = appointmentData.coverage !== undefined && appointmentData.coverage !== null;
        const requestedCoverage = appointmentData.coverage || {};
        if (requestedCoverage.payerCategory && requestedCoverage.payerCategory !== 'self' && !requestedCoverage.payerId) {
          const error = new Error('Select an approved payer for sponsored appointment coverage');
          error.statusCode = 400;
          error.code = 'PAYER_REQUIRED';
          throw error;
        }
        if (requestedCoverage.payerId) {
          await createEncounterCoverage({
            req,
            hospitalId: hospital._id,
            encounterType: 'OPD',
            encounterId: appointment._id,
            payload: { ...requestedCoverage, allowPendingRateCard: requestedCoverage.allowPendingRateCard ?? true }
          });
        } else if (coverageProvided) {
          await rememberDeclaredPreference({
            hospitalId: hospital._id,
            patientId,
            payerCategory: 'self',
            payerName: 'Self / Cash',
            beneficiary: {},
            source: 'OPD',
            encounterId: appointment._id,
            userId: req.user?._id,
            usedAt: appointmentData.offlineCapturedAt || appointment.createdAt || operationNow(),
            updateLegacyPatientFields: false
          });
        }
      } catch (coverageError) {
        await Appointment.deleteOne({ _id: appointment._id, hospital_id: hospital._id }).catch(() => {});
        await AdmissionCoverage.deleteMany({ hospitalId: hospital._id, appointmentId: appointment._id }).catch(() => {});
        appointmentSaved = false;
        throw coverageError;
      }

      successfulImports.push({
        localId: appointmentData.localId,
        serverId: appointment._id,
        token: appointment.token,
        serialNumber: appointment.serial_number,
        patientId: patientId,
        patientIdentifier: appointmentData.patient_id
      });

      if (appointmentData.localId) {
        syncLogs.push({
          hospitalId,
          localId: appointmentData.localId,
          entityType: 'APPOINTMENT',
          operationType: 'CREATE',
          data: appointmentData,
          status: 'SYNCED',
          serverId: appointment._id,
          syncedAt: new Date(),
          tempPatientId: appointmentData.patientLocalId,
          tempAppointmentId: appointmentData.localId
        });
      }

    } catch (err) {
      if (calendarMutation && !appointmentSaved) {
        if (calendarMutation.type === 'time-based') {
          calendarMutation.docDay.bookedAppointments = calendarMutation.docDay.bookedAppointments.filter(
            (row) => String(row.appointmentId) !== String(calendarMutation.appointmentId)
          );
        } else {
          calendarMutation.docDay.bookedPatients = calendarMutation.docDay.bookedPatients.filter(
            (row) => String(row.appointmentId) !== String(calendarMutation.appointmentId)
          );
        }
      }
      console.error('Error processing appointment:', err);
      failedImports.push({
        localId: appointmentData.localId,
        reason: err.message
      });
    }
  }

  // Save all calendar updates
  for (const calendar of calendarUpdates.values()) {
    await calendar.save();
  }

  // Bulk insert sync logs
  if (syncLogs.length > 0) {
    await OfflineSyncLog.insertMany(syncLogs);
  }

  res.status(201).json({
    message: 'Bulk appointment sync completed',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    successful: successfulImports,
    failed: failedImports
  });
};

// ========== EXISTING METHODS (Preserved) ==========

// Complete appointment
exports.completeAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, hospital_id: hospitalId },
      {
        status: 'Completed',
        actual_end_time: operationNow(),
        'lifecycleTimestamps.consultationEndedAt': operationNow()
      },
      { new: true }
    );

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await updateCalendarAppointmentStatus(appointment, 'Completed');
    await recalculateQueue({
      hospitalId,
      departmentId: appointment.department_id,
      date: appointment.appointment_date
    });

    try {
      await calculatePartTimeSalary(appointment._id);
    } catch (salaryError) {
      console.error('Error calculating part-time salary:', salaryError);
    }

    await notifyAppointment(appointment, 'appointment_completed', req.user?._id, {
      subject: 'Appointment completed',
      body: 'Your appointment has been completed. Follow-up instructions and records are available in the hospital system.'
    });

    return res.json({
      message: 'Appointment status updated to Completed',
      appointment
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

// Get procedures scheduled for a doctor on a specific date
exports.getDoctorProceduresForDate = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { doctorId, date } = req.params;
    const doctorExists = await Doctor.exists({ _id: doctorId, hospitalId, is_active: { $ne: false } });
    if (!doctorExists) return res.status(404).json({ error: 'Doctor not found' });

    const hospital = await Hospital.findById(hospitalId).select('timezone');
    const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    let dateKey;
    try {
      dateKey = hospitalDateKey(date, timeZone);
    } catch (_error) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    const { start: targetDate, end: nextDate } = hospitalDayBounds(dateKey, timeZone);

    const prescriptions = await Prescription.find({
      'recommendedProcedures.performed_by': doctorId,
      'recommendedProcedures.scheduled_date': {
        $gte: targetDate,
        $lt: nextDate
      },
      'recommendedProcedures.status': { $in: ['Scheduled', 'In Progress', 'Completed'] }
    })
      .populate('patient_id', 'first_name last_name patientId phone')
      .populate('doctor_id', 'firstName lastName')
      .populate({
        path: 'recommendedProcedures.performed_by',
        select: '_id firstName lastName specialization'
      });

    const procedures = [];
    prescriptions.forEach(prescription => {
      (prescription.recommendedProcedures || []).forEach(proc => {
        const isOnTargetDate = proc.scheduled_date &&
          new Date(proc.scheduled_date) >= targetDate &&
          new Date(proc.scheduled_date) < nextDate;

        if (!isOnTargetDate) return;

        let isPerformedByThisDoctor = false;

        if (proc.performed_by) {
          const performedById = typeof proc.performed_by === 'object' && proc.performed_by !== null
            ? proc.performed_by._id.toString()
            : proc.performed_by?.toString();

          isPerformedByThisDoctor = performedById === doctorId;
        }

        if (isPerformedByThisDoctor) {
          let performedBy = null;
          if (proc.performed_by) {
            if (typeof proc.performed_by === 'object' && proc.performed_by !== null) {
              performedBy = {
                _id: proc.performed_by._id,
                name: `Dr. ${proc.performed_by.firstName || ''} ${proc.performed_by.lastName || ''}`.trim(),
                specialization: proc.performed_by.specialization
              };
            } else if (typeof proc.performed_by === 'string') {
              performedBy = {
                _id: proc.performed_by,
                name: 'Unknown',
                specialization: null
              };
            }
          }

          procedures.push({
            _id: proc._id,
            procedure_code: proc.procedure_code,
            procedure_name: proc.procedure_name,
            scheduled_date: proc.scheduled_date,
            completed_date: proc.completed_date || null,
            duration_minutes: proc.duration_minutes || 30,
            performed_by: performedBy,
            patient: {
              _id: prescription.patient_id?._id,
              name: `${prescription.patient_id?.first_name || ''} ${prescription.patient_id?.last_name || ''}`.trim(),
              patientId: prescription.patient_id?.patientId,
              phone: prescription.patient_id?.phone
            },
            prescribing_doctor: {
              _id: prescription.doctor_id?._id,
              name: `Dr. ${prescription.doctor_id?.firstName || ''} ${prescription.doctor_id?.last_name || ''}`.trim()
            },
            status: proc.status,
            notes: proc.notes,
            prescription_id: prescription._id,
            prescription_number: prescription.prescription_number,
            cost: proc.cost || 0,
            is_billed: proc.is_billed || false
          });
        }
      });
    });

    procedures.sort((a, b) => new Date(a.scheduled_date) - new Date(b.scheduled_date));

    res.json({
      success: true,
      count: procedures.length,
      procedures
    });
  } catch (err) {
    console.error('Error fetching doctor procedures:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointments by patient ID
exports.getAppointmentsByPatientId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { patientId } = req.params;
    const { status } = req.query;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));

    const patientExists = await Patient.exists({ _id: patientId, hospitalId, is_active: { $ne: false } });
    if (!patientExists) return res.status(404).json({ error: 'Patient not found' });
    const filter = { patient_id: patientId, hospital_id: hospitalId, is_active: { $ne: false } };
    if (status) filter.status = status;

    const appointments = await Appointment.find(filter)
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('department_id', 'name')
      .populate('hospital_id', 'name')
      .sort({ appointment_date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Appointment.countDocuments(filter);

    res.json({
      appointments,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Create single appointment with hospital-scoped idempotency and atomic calendar reservation
exports.createAppointment = async (req, res) => {
  const suppliedIdempotencyKey = String(
    req.get('Idempotency-Key') || req.body.idempotencyKey || ''
  ).trim();
  const idempotencyKey = suppliedIdempotencyKey || `server:${crypto.randomUUID()}`;

  try {
    const hospitalId = requireHospitalId(req);
    const { type, doctor_id, department_id, appointment_date, duration = 10 } = req.body;
    const hospital = await Hospital.findById(hospitalId).select('timezone');
    if (!hospital) return res.status(404).json({ error: 'Hospital not found' });
    const timeZone = hospital.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    if (req.body.hospital_id && String(req.body.hospital_id) !== String(hospitalId)) {
      return res.status(403).json({ error: 'Hospital scope mismatch', code: 'TENANT_SCOPE_MISMATCH' });
    }
    if (!type || !doctor_id || !department_id || !appointment_date || !req.body.patient_id) {
      return res.status(400).json({ error: 'Missing required fields', code: 'VALIDATION_ERROR' });
    }

    let dateKey;
    try {
      dateKey = hospitalDateKey(appointment_date, timeZone);
    } catch (_error) {
      return res.status(400).json({ error: 'Invalid appointment_date', code: 'VALIDATION_ERROR' });
    }
    const appointmentDate = dateKeyToStorageDate(dateKey);
    const durationMinutes = Number(duration);
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440) {
      return res.status(400).json({ error: 'duration must be between 1 and 1440 minutes', code: 'VALIDATION_ERROR' });
    }

    const visitMode = req.body.visit_mode || 'physical';
    if (!['physical', 'teleconsultation', 'homecare'].includes(visitMode)) {
      return res.status(400).json({ error: 'Invalid visit_mode', code: 'VALIDATION_ERROR' });
    }
    if (visitMode === 'teleconsultation' && !req.body.teleconsultation?.consentCaptured) {
      return res.status(400).json({
        error: 'Teleconsultation consent is required',
        code: 'TELECONSULTATION_CONSENT_REQUIRED'
      });
    }

    const externalSystem = String(req.body.externalBooking?.system || '').trim();
    const externalAppointmentId = String(req.body.externalBooking?.externalAppointmentId || '').trim();
    if (externalSystem && externalAppointmentId) {
      const externalExisting = await Appointment.findOne({
        hospital_id: hospitalId,
        'externalBooking.system': externalSystem,
        'externalBooking.externalAppointmentId': externalAppointmentId
      });
      if (externalExisting) {
        return res.status(200).json({ ...externalExisting.toObject(), idempotent: true });
      }
    }

    if (suppliedIdempotencyKey) {
      const existing = await Appointment.findOne({ hospital_id: hospitalId, idempotencyKey });
      if (existing) return res.status(200).json({ ...existing.toObject(), idempotent: true });
    }

    const [patient, doctorRecord, departmentRecord] = await Promise.all([
      Patient.findOne({ _id: req.body.patient_id, hospitalId, is_active: { $ne: false } }),
      Doctor.findOne({ _id: doctor_id, hospitalId, is_active: { $ne: false } }),
      Department.findOne({ _id: department_id, hospitalId, is_active: { $ne: false } })
    ]);
    if (!patient) return res.status(404).json({ error: 'Patient not found for this hospital' });
    try {
      await assertPatientReadyForContext({
        hospitalId,
        patientId: patient._id,
        context: 'OPD',
        userId: req.user?._id
      });
    } catch (registrationError) {
      return res.status(registrationError.statusCode || 409).json({
        error: registrationError.code || 'PATIENT_REGISTRATION_INCOMPLETE',
        message: registrationError.message,
        missingFields: registrationError.missingFields || registrationError.completeness?.missingFields || []
      });
    }
    if (!doctorRecord) return res.status(404).json({ error: 'Doctor not found for this hospital' });
    if (!departmentRecord) return res.status(404).json({ error: 'Department not found for this hospital' });
    if (req.body.episodeId) {
      if (!mongoose.isValidObjectId(req.body.episodeId)) {
        return res.status(400).json({ error: 'Invalid episodeId' });
      }
      const episode = await Episode.exists({ _id: req.body.episodeId, patientId: patient._id });
      if (!episode) {
        return res.status(404).json({ error: 'Episode not found for the appointment patient' });
      }
    }

    let parsedStartTime = null;
    if (type === 'time-based') {
      if (!req.body.start_time) {
        return res.status(400).json({ error: 'Start time is required for time-based appointments' });
      }
      try {
        parsedStartTime = parseHospitalDateTime(req.body.start_time, dateKey, timeZone);
        assertInstantOnHospitalDate(parsedStartTime, dateKey, timeZone);
      } catch (error) {
        return res.status(400).json({ error: error.message, code: error.code || 'VALIDATION_ERROR' });
      }
    }
    const bookingFingerprint = canonicalBookingFingerprint({
      hospitalId,
      patientId: patient._id,
      doctorId: doctor_id,
      appointmentDateKey: dateKey,
      type,
      startTime: parsedStartTime
    });

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
    const calendarTimeZone = calendar.timezone || timeZone;
    const day = calendar.days.find((row) => calendarDayKey(row, calendarTimeZone) === dateKey);
    if (!day) return res.status(404).json({ error: 'Date not found in calendar' });
    const doctorDay = day.doctors.find((row) => row.doctorId.toString() === doctor_id.toString());
    if (!doctorDay) return res.status(404).json({ error: 'Doctor not found on this date' });

    const appointment = new Appointment({
      hospital_id: hospitalId,
      patient_id: patient._id,
      doctor_id,
      department_id,
      appointment_date: appointmentDate,
      appointment_date_key: dateKey,
      scheduled_timezone: timeZone,
      duration: durationMinutes,
      status: 'Scheduled',
      type: type === 'time-based' ? 'time-based' : 'number-based',
      appointment_type: req.body.appointment_type || 'consultation',
      priority: req.body.priority || 'Normal',
      notes: req.body.notes || '',
      episodeId: req.body.episodeId || undefined,
      coverageId: undefined,
      sponsorType: 'self',
      sponsorName: undefined,
      idempotencyKey,
      bookingFingerprint,
      submissionSource: req.body.submissionSource || 'APPOINTMENT_MODAL',
      bookedBy: req.user?._id,
      visit_mode: visitMode,
      teleconsultation: {
        communicationMode: visitMode === 'teleconsultation'
          ? (req.body.teleconsultation?.communicationMode || 'video')
          : 'not_applicable',
        meetingUrl: req.body.teleconsultation?.meetingUrl,
        meetingReference: req.body.teleconsultation?.meetingReference,
        consentCaptured: Boolean(req.body.teleconsultation?.consentCaptured),
        consentCapturedAt: req.body.teleconsultation?.consentCaptured ? operationNow() : undefined,
        consentCapturedBy: req.body.teleconsultation?.consentCaptured ? req.user?._id : undefined
      },
      attachments: Array.isArray(req.body.attachments)
        ? req.body.attachments.slice(0, 20).map((item) => ({
          name: item?.name,
          url: item?.url,
          mimeType: item?.mimeType,
          addedAt: operationNow(),
          addedBy: req.user?._id
        }))
        : [],
      externalBooking: externalSystem && externalAppointmentId
        ? {
          system: externalSystem,
          externalAppointmentId,
          sourceUpdatedAt: req.body.externalBooking?.sourceUpdatedAt,
          lastSyncedAt: new Date(),
          rawPayload: req.body.externalBooking?.rawPayload || req.body
        }
        : undefined,
      lifecycleTimestamps: { bookedAt: operationNow() }
    });

    appointment.token = await nextAppointmentToken({
      hospitalId,
      patientType: patient.patient_type,
      appointmentDate,
      appointmentDateKey: dateKey,
      timeZone
    });

    if (appointment.type === 'time-based') {
      const startTime = parsedStartTime;
      const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
      if (hasTimeConflict(doctorDay.bookedAppointments, startTime, endTime, doctorDay.breaks)) {
        return res.status(409).json({
          error: 'Time slot not available (conflict with appointment or break)',
          code: 'SLOT_CONFLICT'
        });
      }
      appointment.start_time = startTime;
      appointment.end_time = endTime;
      doctorDay.bookedAppointments.push({
        startTime,
        endTime,
        duration: durationMinutes,
        appointmentId: appointment._id,
        status: 'Scheduled'
      });
    } else {
      const serialNumber = doctorDay.bookedPatients.reduce(
        (max, row) => Math.max(max, Number(row.serialNumber || 0)),
        0
      ) + 1;
      appointment.serial_number = serialNumber;
      doctorDay.bookedPatients.push({
        patientId: appointment.patient_id,
        serialNumber,
        appointmentId: appointment._id
      });
    }

    await appointment.save();

    let encounterCoverage = null;
    try {
      const coverageProvided = req.body.coverage !== undefined && req.body.coverage !== null;
      const requestedCoverage = req.body.coverage || {};
      if (requestedCoverage.payerCategory && requestedCoverage.payerCategory !== 'self' && !requestedCoverage.payerId) {
        const error = new Error('Select an approved payer for sponsored appointment coverage');
        error.statusCode = 400;
        error.code = 'PAYER_REQUIRED';
        throw error;
      }
      if (requestedCoverage.payerId) {
        encounterCoverage = await createEncounterCoverage({
          req,
          hospitalId,
          encounterType: 'OPD',
          encounterId: appointment._id,
          payload: { ...requestedCoverage, allowPendingRateCard: requestedCoverage.allowPendingRateCard ?? true }
        });
      } else if (coverageProvided) {
        await rememberDeclaredPreference({
          hospitalId,
          patientId: patient._id,
          payerCategory: 'self',
          payerName: 'Self / Cash',
          beneficiary: {},
          source: 'OPD',
          encounterId: appointment._id,
          userId: req.user?._id,
          usedAt: operationNow(),
          updateLegacyPatientFields: false
        });
      }
    } catch (coverageError) {
      await Appointment.deleteOne({ _id: appointment._id, hospital_id: hospitalId }).catch(() => {});
      throw coverageError;
    }

    // Snapshot the encounter-level financial mode independently from the patient.
    // The actual consultation/service charge will resolve the same policy again
    // with authoritative tariff amounts, but the appointment preserves the user's
    // allowed selection for safe resume/retry and subsequent source charges.
    try {
      const appointmentPolicy = await resolveFinancialPolicy({
        hospitalId,
        user: req.user,
        encounterType: 'OPD',
        serviceType: 'CONSULTATION',
        serviceCode: 'OPD-CONS',
        payerCategory: encounterCoverage?.payerCategory || req.body.coverage?.payerCategory || 'SELF',
        departmentId: appointment.department_id,
        selectedMode: req.body.selectedMode || req.body.selectedBillingMode,
        patientLiability: 0,
        sponsorLiability: 0,
        contractedAmount: 0,
        overrideReason: req.body.billingModeOverrideReason
      });
      appointment.selectedBillingMode = appointmentPolicy.selectedMode;
      appointment.financialPolicySnapshot = appointmentPolicy.policySnapshot;
      await appointment.save();
    } catch (policyError) {
      await Appointment.deleteOne({ _id: appointment._id, hospital_id: hospitalId }).catch(() => {});
      if (encounterCoverage?._id) {
        await AdmissionCoverage.deleteMany({ hospitalId, appointmentId: appointment._id }).catch(() => {});
      }
      throw policyError;
    }

    try {
      await calendar.save();
    } catch (calendarError) {
      await Appointment.deleteOne({ _id: appointment._id, hospital_id: hospitalId }).catch(() => {});
      if (encounterCoverage?._id) {
        await AdmissionCoverage.deleteMany({ hospitalId, appointmentId: appointment._id }).catch(() => {});
      }
      throw calendarError;
    }

    if (req.body.localId) {
      await OfflineSyncLog.updateOne(
        { hospitalId, localId: req.body.localId, entityType: 'APPOINTMENT' },
        {
          $setOnInsert: { hospitalId, operationType: 'CREATE', data: req.body },
          $set: {
            status: 'SYNCED',
            serverId: appointment._id,
            syncedAt: new Date(),
            tempAppointmentId: req.body.localId
          }
        },
        { upsert: true }
      );
    }

    await recalculateQueue({
      hospitalId,
      departmentId: appointment.department_id,
      date: appointment.appointment_date
    });

    let notificationWarning;
    try {
      await notifyAppointment(appointment, 'appointment_booked', req.user?._id);
    } catch (notificationError) {
      notificationWarning = notificationError.message;
      console.error('Appointment saved but booking notification could not be queued:', notificationError);
    }

    await appendDomainEvent({
      req,
      eventType: 'opd.appointment.created',
      entityType: 'Appointment',
      entityId: appointment._id,
      hospitalId,
      patientId: patient._id,
      encounterId: appointment._id,
      afterSummary: {
        status: appointment.status,
        appointmentDate: appointment.appointment_date,
        doctorId: appointment.doctor_id,
        departmentId: appointment.department_id
      }
    });

    const persistedAppointment = await Appointment.findOne({ _id: appointment._id, hospital_id: hospitalId });
    return res.status(201).json({
      ...(persistedAppointment || appointment).toObject(),
      coverage: encounterCoverage || undefined,
      ...(suppliedIdempotencyKey ? {} : { serverGeneratedIdempotencyKey: true }),
      ...(notificationWarning ? { notificationWarning } : {})
    });
  } catch (err) {
    if (err?.code === 11000) {
      const hospitalId = requireHospitalId(req);
      const repeated = suppliedIdempotencyKey
        ? await Appointment.findOne({ hospital_id: hospitalId, idempotencyKey })
        : await Appointment.findOne({
          hospital_id: hospitalId,
          'externalBooking.system': req.body.externalBooking?.system,
          'externalBooking.externalAppointmentId': req.body.externalBooking?.externalAppointmentId
        });
      if (repeated) return res.status(200).json({ ...repeated.toObject(), idempotent: true });
    }
    return res.status(err.statusCode || 400).json({
      error: err.code || err.message,
      message: err.message,
      code: err.code
    });
  }
};

// Synchronize an appointment created or changed in an approved external channel.
// The existing create/update/cancel handlers remain the single source of business rules.
exports.syncExternalAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const externalSystem = String(req.body.externalSystem || req.body.externalBooking?.system || '').trim();
    const externalAppointmentId = String(
      req.body.externalAppointmentId || req.body.externalBooking?.externalAppointmentId || ''
    ).trim();
    const action = String(req.body.action || 'upsert').toLowerCase();

    if (!externalSystem || !externalAppointmentId) {
      return res.status(400).json({
        error: 'externalSystem and externalAppointmentId are required',
        code: 'EXTERNAL_APPOINTMENT_REFERENCE_REQUIRED'
      });
    }

    const existing = await Appointment.findOne({
      hospital_id: hospitalId,
      'externalBooking.system': externalSystem,
      'externalBooking.externalAppointmentId': externalAppointmentId
    });

    const sourceUpdatedAt = req.body.sourceUpdatedAt ? new Date(req.body.sourceUpdatedAt) : new Date();
    if (Number.isNaN(sourceUpdatedAt.getTime())) {
      return res.status(400).json({ error: 'Invalid sourceUpdatedAt' });
    }
    if (existing?.externalBooking?.sourceUpdatedAt && sourceUpdatedAt < existing.externalBooking.sourceUpdatedAt) {
      return res.status(409).json({
        error: 'A newer version of this external appointment is already stored',
        code: 'STALE_EXTERNAL_APPOINTMENT_UPDATE',
        appointment: existing
      });
    }

    if (action === 'cancel') {
      if (!existing) return res.status(404).json({ error: 'External appointment not found' });
      req.params.id = String(existing._id);
      req.body.reason = req.body.reason || req.body.cancellationReason || `Cancelled by ${externalSystem}`;
      return exports.cancelAppointment(req, res);
    }

    if (existing) {
      req.params.id = String(existing._id);
      req.body = {
        ...req.body,
        externalBooking: {
          system: externalSystem,
          externalAppointmentId,
          sourceUpdatedAt,
          lastSyncedAt: new Date(),
          rawPayload: req.body
        }
      };
      return exports.updateAppointment(req, res);
    }

    req.body = {
      ...req.body,
      hospital_id: hospitalId,
      submissionSource: `EXTERNAL:${externalSystem}`,
      externalBooking: {
        system: externalSystem,
        externalAppointmentId,
        sourceUpdatedAt,
        lastSyncedAt: new Date(),
        rawPayload: req.body
      },
      idempotencyKey: req.body.idempotencyKey || `external:${externalSystem}:${externalAppointmentId}`
    };
    req.headers['idempotency-key'] = req.body.idempotencyKey;
    return exports.createAppointment(req, res);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message, code: error.code });
  }
};

exports.checkInAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const checkedInAt = operationNow();
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, hospital_id: hospitalId, status: { $nin: ['Cancelled', 'Completed'] } },
      {
        $set: {
          status: 'In Progress',
          'lifecycleTimestamps.checkedInAt': checkedInAt
        }
      },
      { new: true, runValidators: true }
    );
    if (!appointment) return res.status(404).json({ error: 'Appointment not found or cannot be checked in' });
    await updateCalendarAppointmentStatus(appointment, 'In Progress');

    const queue = await recalculateQueue({
      hospitalId,
      departmentId: appointment.department_id,
      date: appointment.appointment_date
    });
    const refreshed = queue.find((row) => String(row._id) === String(appointment._id)) || appointment;
    await notifyAppointment(refreshed, 'appointment_checked_in', req.user?._id, {
      subject: 'Patient check-in confirmed',
      body: `Check-in is complete. Queue position: ${refreshed.queuePosition || 'pending'}.`
    });
    return res.json({ message: 'Appointment checked in', appointment: refreshed });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

exports.startConsultation = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const current = await Appointment.findOne({ _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } });
    if (!current) return res.status(404).json({ error: 'Appointment not found' });
    if (current.status === 'Cancelled' || current.status === 'Completed') {
      return res.status(409).json({ error: `${current.status} appointments cannot be started`, code: 'INVALID_APPOINTMENT_STATE' });
    }
    if (current.status === 'In Progress') {
      return res.json({
        success: true,
        message: 'Consultation is already active',
        appointment: current,
        encounter: { type: 'OPD', id: current._id, status: 'active' },
        alreadyStarted: true
      });
    }

    await guardConsultationStart({ hospitalId, appointment: current, user: req.user });
    const startedAt = operationNow();
    const appointment = await Appointment.findOneAndUpdate(
      { _id: current._id, hospital_id: hospitalId, status: 'Scheduled' },
      {
        $set: {
          status: 'In Progress',
          actual_start_time: startedAt,
          'lifecycleTimestamps.consultationStartedAt': startedAt
        }
      },
      { new: true, runValidators: true }
    );
    if (!appointment) return res.status(409).json({ error: 'Appointment state changed before consultation could start', code: 'APPOINTMENT_STATE_CONFLICT' });
    await updateCalendarAppointmentStatus(appointment, 'In Progress');
    await recalculateQueue({ hospitalId, departmentId: appointment.department_id, date: appointment.appointment_date });
    await setDoctorOpdAvailability({
      hospitalId,
      doctorId: appointment.doctor_id,
      status: 'in_opd',
      userId: req.user?._id,
      note: `Active OPD consultation ${appointment._id}`
    });
    return res.json({
      success: true,
      message: 'Consultation started',
      appointment,
      encounter: { type: 'OPD', id: appointment._id, patientId: appointment.patient_id, status: 'active', startedAt }
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
  }
};

exports.getCurrentQueue = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const departmentId = req.query.departmentId || req.query.department_id;
    const date = req.query.date || new Date();
    if (!departmentId) return res.status(400).json({ error: 'departmentId is required' });
    if (!mongoose.isValidObjectId(departmentId)
      || !(await Department.exists({ _id: departmentId, hospitalId }))) {
      return res.status(404).json({ error: 'Department not found for this hospital' });
    }
    const hospital = await Hospital.findById(hospitalId).select('timezone');
    const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    let dateKey;
    try {
      dateKey = hospitalDateKey(date, timeZone);
    } catch (_error) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    await recalculateQueue({ hospitalId, departmentId, date: dateKey, timeZone });
    const daySelector = appointmentDaySelector(dateKey, timeZone);
    const rows = await Appointment.find({
      hospital_id: hospitalId,
      department_id: departmentId,
      status: { $in: ['Scheduled', 'In Progress'] },
      ...daySelector
    })
      .populate('patient_id', 'first_name last_name patientId uhid')
      .populate('doctor_id', 'firstName lastName')
      .sort({ queuePosition: 1, start_time: 1, serial_number: 1 });
    return res.json({ date: dateKey, departmentId, queue: rows });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

// Get all appointments
exports.getAllAppointments = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospital_id: hospitalId, is_active: { $ne: false } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.visit_mode) filter.visit_mode = req.query.visit_mode;
    if (req.query.from || req.query.to) {
      const hospital = await Hospital.findById(hospitalId).select('timezone');
      const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
      let fromKey = null;
      let toKey = null;
      try {
        if (req.query.from) fromKey = hospitalDateKey(req.query.from, timeZone);
        if (req.query.to) toKey = hospitalDateKey(req.query.to, timeZone);
      } catch (_error) {
        return res.status(400).json({ error: 'Invalid appointment date range' });
      }
      const keyRange = {};
      if (fromKey) keyRange.$gte = fromKey;
      if (toKey) keyRange.$lte = toKey;
      const instantRange = {};
      if (fromKey) instantRange.$gte = hospitalDayBounds(fromKey, timeZone).start;
      if (toKey) instantRange.$lt = hospitalDayBounds(toKey, timeZone).end;
      filter.$or = [
        { appointment_date_key: keyRange },
        { appointment_date: instantRange }
      ];
    }
    const limit = Math.min(2000, Math.max(1, Number.parseInt(req.query.limit, 10) || 1000));
    const appointments = await Appointment.find(filter)
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id')
      .sort({ appointment_date: -1 })
      .limit(limit);

    const appointmentsWithVitals = await Promise.all(appointments.map(async (appt) => {
      const vital = await Vital.findOne({ appointment_id: appt._id });
      return {
        ...appt.toObject(),
        vitals: vital || null
      };
    }));

    res.json(appointmentsWithVitals);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointment by ID
exports.getAppointmentById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    const vitals = await Vital.findOne({ appointment_id: appointment._id });
    const prescription = await Prescription.findOne({ appointment_id: appointment._id });

    res.json({
      ...appointment.toObject(),
      prescription: prescription || null,
      vitals: vitals || null
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Update or reschedule an appointment while preserving the existing calendar flow.
exports.updateAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (req.body.type && req.body.type !== appointment.type) {
      return res.status(400).json({ error: 'Cannot change appointment type' });
    }

    const oldAppointmentDate = new Date(appointment.appointment_date);
    const oldDepartmentId = appointment.department_id;
    const targetStatus = req.body.status !== undefined ? String(req.body.status) : appointment.status;
    if (targetStatus === 'Cancelled') {
      return res.status(400).json({ error: 'Use the cancellation action and provide a cancellation reason' });
    }
    if (!['Scheduled', 'In Progress', 'Completed'].includes(targetStatus)) {
      return res.status(400).json({ error: 'Invalid appointment status' });
    }

    const scheduleFields = [
      'appointment_date', 'doctor_id', 'department_id', 'start_time', 'duration', 'serial_number'
    ];
    const scheduleChanged = scheduleFields.some((field) => req.body[field] !== undefined);
    if (scheduleChanged && ['Completed', 'Cancelled'].includes(appointment.status)) {
      return res.status(409).json({ error: `${appointment.status} appointments cannot be rescheduled` });
    }

    const timeZone = appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    let targetDateKey;
    try {
      targetDateKey = req.body.appointment_date
        ? hospitalDateKey(req.body.appointment_date, timeZone)
        : (appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone));
    } catch (_error) {
      return res.status(400).json({ error: 'Invalid appointment_date' });
    }
    const targetDate = dateKeyToStorageDate(targetDateKey);
    const targetDoctorId = req.body.doctor_id || appointment.doctor_id;
    const targetDepartmentId = req.body.department_id || appointment.department_id;
    const targetDuration = req.body.duration !== undefined
      ? Number(req.body.duration)
      : Number(appointment.duration || 10);
    if (!Number.isFinite(targetDuration) || targetDuration <= 0 || targetDuration > 1440) {
      return res.status(400).json({ error: 'duration must be between 1 and 1440 minutes' });
    }

    const [doctorRecord, departmentRecord] = await Promise.all([
      Doctor.findOne({ _id: targetDoctorId, hospitalId }).select('_id'),
      Department.findOne({ _id: targetDepartmentId, hospitalId }).select('_id')
    ]);
    if (!doctorRecord) return res.status(404).json({ error: 'Doctor not found for this hospital' });
    if (!departmentRecord) return res.status(404).json({ error: 'Department not found for this hospital' });
    if (targetStatus === 'In Progress' && appointment.status !== 'In Progress') {
      await guardConsultationStart({ hospitalId, appointment, doctorId: targetDoctorId, user: req.user });
    }

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });
    const calendarTimeZone = calendar.timezone || timeZone;
    const oldDateKey = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone);
    const oldDay = calendar.days.find((day) => calendarDayKey(day, calendarTimeZone) === oldDateKey);
    const oldDoctorDay = oldDay?.doctors?.find(
      (row) => String(row.doctorId) === String(appointment.doctor_id)
    );
    const targetDay = calendar.days.find((day) => calendarDayKey(day, calendarTimeZone) === targetDateKey);
    if (!targetDay) return res.status(404).json({ error: 'Target date is not available in the calendar' });
    const targetDoctorDay = targetDay.doctors.find(
      (row) => String(row.doctorId) === String(targetDoctorId)
    );
    if (!targetDoctorDay) {
      return res.status(404).json({ error: 'Doctor is not scheduled on the target date' });
    }

    if (appointment.type === 'time-based') {
      let targetStart;
      try {
        targetStart = req.body.start_time
          ? parseHospitalDateTime(req.body.start_time, targetDateKey, timeZone)
          : new Date(appointment.start_time);
        assertInstantOnHospitalDate(targetStart, targetDateKey, timeZone);
      } catch (error) {
        return res.status(400).json({ error: error.message, code: error.code || 'VALIDATION_ERROR' });
      }
      const targetEnd = new Date(targetStart.getTime() + targetDuration * 60000);
      const otherAppointments = targetDoctorDay.bookedAppointments.filter(
        (row) => String(row.appointmentId) !== String(appointment._id)
      );
      if (hasTimeConflict(otherAppointments, targetStart, targetEnd, targetDoctorDay.breaks)) {
        return res.status(409).json({
          error: 'New time slot conflicts with an appointment or scheduled break',
          code: 'SLOT_CONFLICT'
        });
      }

      if (oldDoctorDay) {
        oldDoctorDay.bookedAppointments = oldDoctorDay.bookedAppointments.filter(
          (row) => String(row.appointmentId) !== String(appointment._id)
        );
      }
      targetDoctorDay.bookedAppointments.push({
        startTime: targetStart,
        endTime: targetEnd,
        duration: targetDuration,
        appointmentId: appointment._id,
        status: targetStatus === 'In Progress' ? 'InProgress' : targetStatus
      });
      appointment.start_time = targetStart;
      appointment.end_time = targetEnd;
      appointment.duration = targetDuration;
    } else {
      if (oldDoctorDay) {
        oldDoctorDay.bookedPatients = oldDoctorDay.bookedPatients.filter(
          (row) => String(row.appointmentId) !== String(appointment._id)
        );
      }
      const requestedSerial = req.body.serial_number !== undefined
        ? Number(req.body.serial_number)
        : null;
      if (requestedSerial !== null && (!Number.isInteger(requestedSerial) || requestedSerial < 1)) {
        return res.status(400).json({ error: 'serial_number must be a positive integer' });
      }
      const serialNumber = requestedSerial || (
        targetDoctorDay.bookedPatients.reduce(
          (maximum, row) => Math.max(maximum, Number(row.serialNumber || 0)),
          0
        ) + 1
      );
      const occupied = targetDoctorDay.bookedPatients.some(
        (row) => Number(row.serialNumber) === serialNumber
          && String(row.appointmentId) !== String(appointment._id)
      );
      if (occupied) return res.status(409).json({ error: 'Serial number already assigned' });
      targetDoctorDay.bookedPatients.push({
        patientId: appointment.patient_id,
        serialNumber,
        appointmentId: appointment._id
      });
      appointment.serial_number = serialNumber;
      appointment.duration = targetDuration;
    }

    appointment.appointment_date = targetDate;
    appointment.appointment_date_key = targetDateKey;
    appointment.scheduled_timezone = timeZone;
    appointment.doctor_id = targetDoctorId;
    appointment.department_id = targetDepartmentId;
    appointment.bookingFingerprint = canonicalBookingFingerprint({
      hospitalId,
      patientId: appointment.patient_id,
      doctorId: targetDoctorId,
      appointmentDateKey: targetDateKey,
      type: appointment.type,
      startTime: appointment.start_time
    });

    const {
      notes, priority, appointment_type, visit_mode,
      teleconsultation, attachments, externalBooking
    } = req.body;
    if (notes !== undefined) appointment.notes = String(notes);
    if (priority !== undefined) appointment.priority = priority;
    if (appointment_type !== undefined) appointment.appointment_type = appointment_type;

    const targetVisitMode = visit_mode || appointment.visit_mode || 'physical';
    if (!['physical', 'teleconsultation', 'homecare'].includes(targetVisitMode)) {
      return res.status(400).json({ error: 'Invalid visit_mode' });
    }
    const existingTeleconsultation = appointment.teleconsultation?.toObject?.()
      || appointment.teleconsultation
      || {};
    const consentCaptured = Boolean(
      teleconsultation?.consentCaptured || existingTeleconsultation.consentCaptured
    );
    if (targetVisitMode === 'teleconsultation' && !consentCaptured) {
      return res.status(400).json({ error: 'Teleconsultation consent is required' });
    }
    appointment.visit_mode = targetVisitMode;
    appointment.teleconsultation = targetVisitMode === 'teleconsultation'
      ? {
        ...existingTeleconsultation,
        ...(teleconsultation || {}),
        communicationMode: teleconsultation?.communicationMode
          || existingTeleconsultation.communicationMode
          || 'video',
        consentCaptured: true,
        consentCapturedAt: existingTeleconsultation.consentCapturedAt || operationNow(),
        consentCapturedBy: existingTeleconsultation.consentCapturedBy || req.user?._id
      }
      : {
        communicationMode: 'not_applicable',
        consentCaptured: false
      };

    if (attachments !== undefined) {
      if (!Array.isArray(attachments) || attachments.length > 20) {
        return res.status(400).json({ error: 'attachments must contain at most 20 items' });
      }
      appointment.attachments = attachments.map((item) => ({
        name: item?.name,
        url: item?.url,
        mimeType: item?.mimeType,
        addedAt: item?.addedAt || operationNow(),
        addedBy: req.user?._id
      }));
    }
    if (externalBooking !== undefined) {
      appointment.externalBooking = {
        ...(appointment.externalBooking?.toObject?.() || appointment.externalBooking || {}),
        system: externalBooking.system || appointment.externalBooking?.system,
        externalAppointmentId: externalBooking.externalAppointmentId
          || appointment.externalBooking?.externalAppointmentId,
        sourceUpdatedAt: externalBooking.sourceUpdatedAt,
        lastSyncedAt: new Date(),
        rawPayload: externalBooking.rawPayload
      };
    }
    appointment.status = targetStatus;
    appointment.lifecycleTimestamps = appointment.lifecycleTimestamps || {};
    const statusChangedAt = operationNow();
    if (targetStatus === 'In Progress') {
      appointment.actual_start_time = appointment.actual_start_time || statusChangedAt;
      appointment.lifecycleTimestamps.consultationStartedAt =
        appointment.lifecycleTimestamps.consultationStartedAt || statusChangedAt;
    }
    if (targetStatus === 'Completed') {
      appointment.actual_end_time = appointment.actual_end_time || statusChangedAt;
      appointment.lifecycleTimestamps.consultationEndedAt =
        appointment.lifecycleTimestamps.consultationEndedAt || statusChangedAt;
    }

    await appointment.save();
    try {
      await calendar.save();
    } catch (calendarError) {
      throw calendarError;
    }

    if (targetStatus === 'In Progress') {
      await setDoctorOpdAvailability({ hospitalId, doctorId: targetDoctorId, status: 'in_opd', userId: req.user?._id, note: `Active OPD consultation ${appointment._id}` });
    } else if (targetStatus === 'Completed' && appointment.status === 'Completed') {
      const anotherActive = await Appointment.exists({ hospital_id: hospitalId, doctor_id: targetDoctorId, status: 'In Progress', _id: { $ne: appointment._id } });
      if (!anotherActive) await setDoctorOpdAvailability({ hospitalId, doctorId: targetDoctorId, status: 'available', userId: req.user?._id, note: 'OPD consultation completed' });
    }

    await Promise.all([
      recalculateQueue({
        hospitalId,
        departmentId: targetDepartmentId,
        date: targetDate
      }),
      (String(targetDepartmentId) !== String(oldDepartmentId)
        || oldDateKey !== targetDateKey)
        ? recalculateQueue({
          hospitalId,
          departmentId: oldDepartmentId,
          date: oldAppointmentDate
        })
        : Promise.resolve([])
    ]);

    try {
      await notifyAppointment(appointment, 'appointment_updated', req.user?._id, {
        subject: 'Appointment updated',
        body: `Your appointment has been updated for ${appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE)}.`
      });
    } catch (notificationError) {
      console.error('Appointment updated but notification could not be queued:', notificationError);
    }
    return res.json(appointment);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
  }
};

// Cancel appointment while retaining the appointment and cancellation history.
exports.cancelAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const reason = String(req.body.reason || req.body.cancellationReason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Cancellation reason is required' });

    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (appointment.status === 'Completed') {
      return res.status(409).json({ error: 'A completed appointment cannot be cancelled' });
    }
    if (appointment.status === 'Cancelled') {
      return res.status(409).json({ error: 'Appointment is already cancelled' });
    }

    const cancelledAt = operationNow();
    appointment.status = 'Cancelled';
    appointment.cancellationReason = reason;
    appointment.cancelledAt = cancelledAt;
    appointment.cancelledBy = req.user?._id;
    appointment.lifecycleTimestamps = appointment.lifecycleTimestamps || {};
    appointment.lifecycleTimestamps.cancelledAt = cancelledAt;
    appointment.cancellationHistory.push({
      reason,
      cancelledAt,
      cancelledBy: req.user?._id
    });

    await Promise.all([
      appointment.save(),
      removeAppointmentFromCalendar(appointment)
    ]);

    await recalculateQueue({
      hospitalId: appointment.hospital_id,
      departmentId: appointment.department_id,
      date: appointment.appointment_date
    });
    await notifyAppointment(appointment, 'appointment_cancelled', req.user?._id, {
      subject: 'Appointment cancelled',
      body: `Your appointment has been cancelled. Reason: ${reason}`
    });

    const populated = await Appointment.findOne({ _id: appointment._id, hospital_id: hospitalId })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('cancelledBy', 'name email role');

    return res.json({
      success: true,
      message: 'Appointment cancelled successfully',
      appointment: populated
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

// Archive appointment. The record and ObjectId are retained for every historical reference.
exports.deleteAppointment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      hospital_id: hospitalId,
      is_active: { $ne: false }
    });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    const now = operationNow();
    const reason = String(req.body?.reason || 'Appointment cancelled and archived by user').trim();
    appointment.status = 'Cancelled';
    appointment.is_active = false;
    appointment.cancelledAt = appointment.cancelledAt || now;
    appointment.cancelledBy = appointment.cancelledBy || req.user?._id || null;
    appointment.cancellationReason = appointment.cancellationReason || reason;
    appointment.lifecycleTimestamps = appointment.lifecycleTimestamps || {};
    appointment.lifecycleTimestamps.cancelledAt = appointment.lifecycleTimestamps.cancelledAt || now;
    if (!appointment.cancellationHistory.some((row) => row.reason === reason && row.cancelledAt)) {
      appointment.cancellationHistory.push({ reason, cancelledAt: now, cancelledBy: req.user?._id || null });
    }
    appointment.deleted_at = now;
    appointment.deleted_by = req.user?._id || null;
    appointment.deletion_reason = reason;

    await Promise.all([
      appointment.save(),
      AdmissionCoverage.updateMany(
        { hospitalId, appointmentId: appointment._id, active: { $ne: false } },
        {
          $set: {
            active: false,
            is_active: false,
            effectiveTo: now,
            deleted_at: now,
            deleted_by: req.user?._id || null,
            deletion_reason: reason
          }
        }
      )
    ]);

    // Calendar cleanup is best-effort. A missing/stale calendar must never prevent
    // the committed appointment record from being safely archived.
    try {
      await removeAppointmentFromCalendar(appointment);
    } catch (calendarError) {
      console.error('Appointment archived but calendar cleanup failed:', calendarError);
    }

    try {
      await recalculateQueue({
        hospitalId,
        departmentId: appointment.department_id,
        date: appointment.appointment_date,
        timeZone: appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE
      });
    } catch (queueError) {
      console.error('Appointment archived but queue recalculation failed:', queueError);
    }

    return res.json({
      success: true,
      message: 'Appointment cancelled and archived successfully',
      appointment
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointments by Doctor ID
exports.getAppointmentsByDoctorId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { doctorId } = req.params;
    const doctorExists = await Doctor.exists({ _id: doctorId, hospitalId, is_active: { $ne: false } });
    if (!doctorExists) return res.status(404).json({ error: 'Doctor not found' });
    const appointments = await Appointment.find({ doctor_id: doctorId, hospital_id: hospitalId, is_active: { $ne: false } })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');

    const appointmentsWithVitals = await Promise.all(appointments.map(async (appt) => {
      const vital = await Vital.findOne({ appointment_id: appt._id });
      return {
        ...appt.toObject(),
        vitals: vital || null
      };
    }));

    res.json(appointmentsWithVitals);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointments by Department ID
exports.getAppointmentsByDepartmentId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { departmentId } = req.params;
    const departmentExists = await Department.exists({ _id: departmentId, hospitalId });
    if (!departmentExists) return res.status(404).json({ error: 'Department not found' });
    const appointments = await Appointment.find({ department_id: departmentId, hospital_id: hospitalId, is_active: { $ne: false } })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this department' });
    }

    res.json(appointments);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get appointments by Hospital ID
exports.getAppointmentsByHospitalId = async (req, res) => {
  try {
    const scopedHospitalId = requireHospitalId(req);
    const { hospitalId } = req.params;
    if (String(hospitalId) !== String(scopedHospitalId)) {
      return res.status(403).json({ error: 'Hospital scope mismatch', code: 'TENANT_SCOPE_MISMATCH' });
    }
    const appointments = await Appointment.find({ hospital_id: scopedHospitalId, is_active: { $ne: false } })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this hospital' });
    }

    res.json(appointments);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get today's appointments for a doctor
exports.getTodaysAppointmentsByDoctorId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { doctorId } = req.params;
    const doctorExists = await Doctor.exists({ _id: doctorId, hospitalId, is_active: { $ne: false } });
    if (!doctorExists) return res.status(404).json({ error: 'Doctor not found' });
    const hospital = await Hospital.findById(hospitalId).select('timezone');
    const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const todayKey = hospitalTodayKey(timeZone);
    const daySelector = appointmentDaySelector(todayKey, timeZone);

    const appointments = await Appointment.find({
      doctor_id: doctorId,
      hospital_id: hospitalId,
      ...daySelector
    })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id')
      .sort({ start_time: 1 });

    res.json(appointments);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Update appointment status
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const statusMap = {
      Scheduled: 'Scheduled',
      InProgress: 'In Progress',
      'In Progress': 'In Progress',
      Completed: 'Completed',
      Cancelled: 'Cancelled'
    };
    const status = statusMap[String(req.body.status || '')];
    if (!status) return res.status(400).json({ error: 'Invalid appointment status' });
    if (status === 'Cancelled') {
      return res.status(400).json({ error: 'Use the cancellation action and provide a cancellation reason' });
    }

    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    const previousStatus = appointment.status;
    const now = operationNow();
    appointment.status = status;
    appointment.lifecycleTimestamps = appointment.lifecycleTimestamps || {};
    if (status === 'In Progress') {
      appointment.actual_start_time = appointment.actual_start_time || now;
      appointment.lifecycleTimestamps.consultationStartedAt =
        appointment.lifecycleTimestamps.consultationStartedAt || now;
    }
    if (status === 'Completed') {
      appointment.actual_end_time = appointment.actual_end_time || now;
      appointment.lifecycleTimestamps.consultationEndedAt =
        appointment.lifecycleTimestamps.consultationEndedAt || now;
      if (appointment.actual_start_time) {
        appointment.duration = Math.max(
          1,
          Math.round((appointment.actual_end_time - appointment.actual_start_time) / 60000)
        );
      }
    }

    const calendar = await Calendar.findOne({ hospitalId });
    if (calendar) {
      const timeZone = calendar.timezone || appointment.scheduled_timezone || DEFAULT_HOSPITAL_TIME_ZONE;
      const dateKey = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone);
      const day = calendar.days.find((row) => calendarDayKey(row, timeZone) === dateKey);
      const doctorDay = day?.doctors?.find(
        (row) => String(row.doctorId) === String(appointment.doctor_id)
      );
      const calendarAppointment = doctorDay?.bookedAppointments?.find(
        (row) => String(row.appointmentId) === String(appointment._id)
      );
      if (calendarAppointment) {
        calendarAppointment.status = status === 'In Progress' ? 'InProgress' : status;
      }
      const calendarPatient = doctorDay?.bookedPatients?.find(
        (row) => String(row.appointmentId) === String(appointment._id)
      );
      if (calendarPatient && 'status' in calendarPatient) {
        calendarPatient.status = status;
      }
    }

    await appointment.save();
    if (calendar) await calendar.save();

    if (status === 'Completed') {
      try {
        await calculatePartTimeSalary(appointment._id);
      } catch (salaryError) {
        console.error('Error calculating part-time salary during status update:', salaryError);
      }
    }

    await recalculateQueue({
      hospitalId,
      departmentId: appointment.department_id,
      date: appointment.appointment_date
    });
    try {
      await notifyAppointment(appointment, `appointment_${status.toLowerCase().replaceAll(' ', '_')}`, req.user?._id, {
        subject: `Appointment ${status.toLowerCase()}`,
        body: `Your appointment status changed from ${previousStatus} to ${status}.`
      });
    } catch (notificationError) {
      console.error('Appointment status saved but notification could not be queued:', notificationError);
    }

    return res.json(appointment);
  } catch (err) {
    console.error('Error updating appointment status:', err);
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
};

// Update Vitals for an Appointment
exports.updateVitals = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { bp, weight, pulse, spo2, temperature, respiratory_rate, random_blood_sugar, height } = req.body;
    const appointmentId = req.params.id;

    const appointment = await Appointment.findOne({ _id: appointmentId, hospital_id: hospitalId });
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    let vitalRecord = await Vital.findOne({ appointment_id: appointmentId });

    if (vitalRecord) {
      vitalRecord.bp = bp || vitalRecord.bp;
      vitalRecord.weight = weight || vitalRecord.weight;
      vitalRecord.pulse = pulse || vitalRecord.pulse;
      vitalRecord.spo2 = spo2 || vitalRecord.spo2;
      vitalRecord.temperature = temperature || vitalRecord.temperature;
      vitalRecord.respiratory_rate = respiratory_rate || vitalRecord.respiratory_rate;
      vitalRecord.random_blood_sugar = random_blood_sugar || vitalRecord.random_blood_sugar;
      vitalRecord.height = height || vitalRecord.height;
      vitalRecord.recorded_at = operationNow();
      vitalRecord.recorded_by = req.user ? req.user._id : vitalRecord.recorded_by;
      await vitalRecord.save();
    } else {
      vitalRecord = await Vital.create({
        patient_id: appointment.patient_id,
        appointment_id: appointmentId,
        recorded_by: req.user ? req.user._id : null,
        bp,
        weight,
        pulse,
        spo2,
        temperature,
        respiratory_rate,
        random_blood_sugar,
        height
      });
    }

    res.json({
      message: 'Vitals updated successfully',
      vitals: vitalRecord
    });
  } catch (err) {
    console.error("Error updating vitals:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get Vitals by Appointment ID
exports.getVitalsByAppointmentId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const appointmentId = req.params.id;
    const appointmentExists = await Appointment.exists({ _id: appointmentId, hospital_id: hospitalId });
    if (!appointmentExists) return res.status(404).json({ error: 'Appointment not found' });
    const vitals = await Vital.findOne({ appointment_id: appointmentId });
    res.json(vitals || null);
  } catch (err) {
    console.error("Error fetching vitals:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.updateHomecareDelivery = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: req.user.hospital_id, visit_mode: 'homecare' });
    if (!appointment) return res.status(404).json({ error: 'Home-care appointment not found' });
    appointment.homecare = { ...(appointment.homecare?.toObject?.() || appointment.homecare || {}), ...req.body };
    if (['delivered','completed'].includes(req.body.deliveryStatus) && !appointment.homecare.deliveredAt) appointment.homecare.deliveredAt = operationNow();
    await appointment.save();
    await notifyAppointment(appointment, 'homecare_delivery_update', req.user?._id, { subject: 'Home-care service update', body: `Home-care service status: ${appointment.homecare.deliveryStatus}`, payload: { homecare: appointment.homecare } });
    return res.json({ success: true, data: appointment });
  } catch (error) { return res.status(400).json({ error: error.message }); }
};
exports.submitHomecareFeedback = async (req, res) => {
  try {
    const rating = Number(req.body.rating); if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be between 1 and 5' });
    const appointment = await Appointment.findOne({ _id: req.params.id, hospital_id: req.user.hospital_id, visit_mode: 'homecare' });
    if (!appointment) return res.status(404).json({ error: 'Home-care appointment not found' });
    appointment.homecare.feedback = { rating, comment: req.body.comment, submittedAt: operationNow() }; await appointment.save();
    return res.json({ success: true, data: appointment.homecare.feedback });
  } catch (error) { return res.status(400).json({ error: error.message }); }
};
