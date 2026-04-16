const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');
const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const { calculatePartTimeSalary } = require('../controllers/salary.controller');

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

function convertUTCTimeToLocalForDate(utcTimeString, targetDateString) {
  if (!utcTimeString) return null;
  const utcDate = new Date(utcTimeString);
  const targetDate = new Date(targetDateString + 'T00:00:00');
  return new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
    utcDate.getUTCHours(),
    utcDate.getUTCMinutes(),
    utcDate.getUTCSeconds()
  );
}

// ========== OFFLINE SYNC METHODS ==========

// Check appointment conflict (for offline pre-check)
exports.checkAppointmentConflict = async (req, res) => {
  try {
    const { doctorId, appointmentDate, startTime, duration = 10 } = req.query;

    const hospital = await Hospital.findOne();
    if (!hospital) {
      return res.json({ hasConflict: false, message: 'No hospital found' });
    }

    const calendar = await Calendar.findOne({ hospitalId: hospital._id });
    if (!calendar) {
      return res.json({ hasConflict: false, message: 'No calendar found' });
    }

    const dateStr = new Date(appointmentDate).toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);

    if (!day) {
      return res.json({ hasConflict: false, message: 'No schedule for this date' });
    }

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
    if (!doctor) {
      return res.json({ hasConflict: false, message: 'Doctor not scheduled for this date' });
    }

    if (startTime) {
      const start = new Date(startTime);
      const end = new Date(start.getTime() + parseInt(duration) * 60000);

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
    res.status(500).json({ error: err.message });
  }
};

// Get appointment by temp ID (for offline resolution)
exports.getAppointmentByTempId = async (req, res) => {
  try {
    const { tempId } = req.params;

    const queueItem = await OfflineSyncLog.findOne({
      tempAppointmentId: tempId,
      entityType: 'APPOINTMENT',
      status: 'SYNCED'
    });

    if (queueItem && queueItem.serverId) {
      const appointment = await Appointment.findById(queueItem.serverId)
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
      localId: tempId,
      entityType: 'APPOINTMENT',
      status: 'SYNCED'
    });

    if (syncLog && syncLog.serverId) {
      const appointment = await Appointment.findById(syncLog.serverId)
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
    res.status(500).json({ error: err.message });
  }
};

// Bulk Create Appointments (Enhanced for offline sync)
exports.bulkCreateAppointments = async (req, res) => {
  const appointmentsData = req.body;

  if (!appointmentsData || !Array.isArray(appointmentsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];
  const syncLogs = [];
  const calendarUpdates = new Map();

  const hospital = await Hospital.findOne();
  if (!hospital) {
    return res.status(500).json({ error: 'Hospital not found.' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const appointmentData of appointmentsData) {
    try {
      // Get patient server ID - Enhanced lookup logic
      let patientId = null;

      // Strategy 1: Check if patient_id is already a MongoDB ObjectId
      if (appointmentData.patient_id && appointmentData.patient_id.match(/^[0-9a-fA-F]{24}$/)) {
        const patient = await Patient.findById(appointmentData.patient_id);
        if (patient) {
          patientId = patient._id;
        }
      }

      // Strategy 2: Lookup by patientLocalId mapping from OfflineSyncLog
      if (!patientId && appointmentData.patientLocalId) {
        const syncLog = await OfflineSyncLog.findOne({
          localId: appointmentData.patientLocalId,
          entityType: 'PATIENT',
          status: 'SYNCED'
        });

        if (syncLog && syncLog.serverId) {
          patientId = syncLog.serverId;
        }
      }

      // Strategy 3: Lookup by phone number
      if (!patientId && appointmentData.phone) {
        const patient = await Patient.findOne({ phone: appointmentData.phone });
        if (patient) {
          patientId = patient._id;
        }
      }

      // Strategy 4: Lookup by patientId (UHID) - THIS IS THE KEY FIX
      if (!patientId && appointmentData.patient_id) {
        const patient = await Patient.findOne({
          $or: [
            { patientId: appointmentData.patient_id },
            { uhid: appointmentData.patient_id }
          ]
        });
        if (patient) {
          patientId = patient._id;
          console.log(`Found patient by patientId/uhid: ${appointmentData.patient_id} -> ${patientId}`);
        }
      }

      // Strategy 5: Lookup by any other identifier in the appointment data
      if (!patientId && appointmentData.uhid) {
        const patient = await Patient.findOne({ uhid: appointmentData.uhid });
        if (patient) {
          patientId = patient._id;
        }
      }

      // If still no patient found, try to create one (optional - based on your business logic)
      if (!patientId && appointmentData.shouldCreatePatient) {
        const newPatient = new Patient({
          patientId: appointmentData.patient_id,
          uhid: appointmentData.patient_id,
          phone: appointmentData.phone || appointmentData.patient_id,
          first_name: appointmentData.patient_first_name || 'Offline',
          last_name: appointmentData.patient_last_name || 'Patient',
          patient_type: appointmentData.patient_type || 'opd'
        });
        await newPatient.save();
        patientId = newPatient._id;
        console.log(`Created new patient for ID: ${appointmentData.patient_id}`);
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

      // Get doctor
      const doctor = await Doctor.findById(appointmentData.doctor_id);
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

      // Prepare appointment data
      const appointmentDate = new Date(appointmentData.appointment_date);
      const isHistorical = appointmentDate < today;

      const appointment = new Appointment({
        patient_id: patientId,
        doctor_id: appointmentData.doctor_id,
        hospital_id: hospital._id,
        department_id: departmentId,
        appointment_date: appointmentDate,
        type: appointmentData.type || 'time-based',
        appointment_type: appointmentData.appointment_type || 'consultation',
        priority: appointmentData.priority || 'Normal',
        notes: appointmentData.notes || '',
        duration: appointmentData.duration || 10,
        status: appointmentData.status || 'Scheduled'
      });

      // Handle calendar for future appointments
      if (!isHistorical) {
        const cacheKey = `${hospital._id}_${appointmentDate.toISOString().split('T')[0]}`;
        let calendar = calendarUpdates.get(cacheKey);

        if (!calendar) {
          calendar = await Calendar.findOne({ hospitalId: hospital._id });
          if (!calendar) {
            calendar = new Calendar({ hospitalId: hospital._id, days: [] });
          }
          calendarUpdates.set(cacheKey, calendar);
        }

        const dateStr = appointmentDate.toISOString().split('T')[0];
        let day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);

        if (!day) {
          const dayName = appointmentDate.toLocaleDateString('en-US', { weekday: 'long' });
          calendar.days.push({
            date: appointmentDate,
            dayName,
            doctors: []
          });
          day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
        }

        let docDay = day.doctors.find(d => d.doctorId.toString() === doctor._id.toString());
        if (!docDay) {
          day.doctors.push({
            doctorId: doctor._id,
            bookedAppointments: [],
            bookedPatients: [],
            breaks: []
          });
          docDay = day.doctors.find(d => d.doctorId.toString() === doctor._id.toString());
        }

        if (appointment.type === 'time-based' && appointmentData.start_time) {
          const startTime = new Date(appointmentData.start_time);
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
            status: appointment.status
          });
        } else if (appointment.type === 'number-based') {
          const lastPatient = docDay.bookedPatients.sort((a, b) => b.serialNumber - a.serialNumber)[0];
          const serialNumber = lastPatient ? lastPatient.serialNumber + 1 : 1;
          appointment.serial_number = serialNumber;

          docDay.bookedPatients.push({
            patientId: appointment.patient_id,
            serialNumber,
            appointmentId: appointment._id
          });
        }
      } else {
        // Historical appointment - set times if provided
        if (appointment.type === 'time-based' && appointmentData.start_time) {
          const startTime = new Date(appointmentData.start_time);
          appointment.start_time = startTime;
          appointment.end_time = new Date(startTime.getTime() + appointment.duration * 60000);
        }
        if (appointment.type === 'number-based' && appointmentData.serial_number) {
          appointment.serial_number = parseInt(appointmentData.serial_number);
        }
      }

      await appointment.save();

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
    const appointment = await Appointment.findByIdAndUpdate(
      req.params.id,
      { status: 'Completed', actual_end_time: new Date() },
      { new: true }
    );

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    try {
      await calculatePartTimeSalary(appointment._id);
    } catch (salaryError) {
      console.error('Error calculating part-time salary:', salaryError);
    }

    res.json({ message: 'Appointment status updated to Completed', appointment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get procedures scheduled for a doctor on a specific date
exports.getDoctorProceduresForDate = async (req, res) => {
  try {
    const { doctorId, date } = req.params;

    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(targetDate.getDate() + 1);

    const prescriptions = await Prescription.find({
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
    res.status(500).json({ error: err.message });
  }
};

// Get appointments by patient ID
exports.getAppointmentsByPatientId = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;

    const filter = { patient_id: patientId };
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
    res.status(500).json({ error: err.message });
  }
};

// Create single appointment
exports.createAppointment = async (req, res) => {
  try {
    const { type, doctor_id, hospital_id, department_id, appointment_date, duration = 10 } = req.body;

    if (!type || !doctor_id || !hospital_id || !department_id || !appointment_date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const appointment = new Appointment({
      ...req.body,
      status: 'Scheduled',
      type: type === 'time-based' ? 'time-based' : 'number-based'
    });

    const calendar = await Calendar.findOne({ hospitalId: hospital_id });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const dateStr = new Date(appointment_date).toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
    if (!day) return res.status(404).json({ error: 'Date not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctor_id.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this date' });

    if (appointment.type === 'time-based') {
      const { start_time } = req.body;
      if (!start_time) {
        return res.status(400).json({ error: 'Start time is required for time-based appointments' });
      }

      const startTime = new Date(start_time);
      const endTime = new Date(startTime.getTime() + duration * 60000);

      if (hasTimeConflict(doctor.bookedAppointments, startTime, endTime, doctor.breaks)) {
        return res.status(409).json({
          error: 'SLOT_CONFLICT',
          message: 'Time slot not available (conflict with appointment or break)'
        });
      }

      appointment.start_time = startTime;
      appointment.end_time = endTime;

      doctor.bookedAppointments.push({
        startTime,
        endTime,
        duration,
        appointmentId: appointment._id,
        status: 'Scheduled'
      });
    } else {
      const lastPatient = doctor.bookedPatients.sort((a, b) => b.serialNumber - a.serialNumber)[0];
      const serialNumber = lastPatient ? lastPatient.serialNumber + 1 : 1;
      appointment.serial_number = serialNumber;
      doctor.bookedPatients.push({
        patientId: appointment.patient_id,
        serialNumber,
        appointmentId: appointment._id
      });
    }

    await Promise.all([appointment.save(), calendar.save()]);

    // Log sync if from offline
    if (req.body.localId) {
      await OfflineSyncLog.create({
        localId: req.body.localId,
        entityType: 'APPOINTMENT',
        operationType: 'CREATE',
        data: req.body,
        status: 'SYNCED',
        serverId: appointment._id,
        syncedAt: new Date(),
        tempAppointmentId: req.body.localId
      });
    }

    res.status(201).json(appointment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all appointments
exports.getAllAppointments = async (req, res) => {
  try {
    const appointments = await Appointment.find()
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id')
      .sort({ appointment_date: -1 });

    const appointmentsWithVitals = await Promise.all(appointments.map(async (appt) => {
      const vital = await Vital.findOne({ appointment_id: appt._id });
      return {
        ...appt.toObject(),
        vitals: vital || null
      };
    }));

    res.json(appointmentsWithVitals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get appointment by ID
exports.getAppointmentById = async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id)
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
    res.status(500).json({ error: err.message });
  }
};

// Update appointment
exports.updateAppointment = async (req, res) => {
  try {
    const { type, start_time, duration } = req.body;
    const appointment = await Appointment.findById(req.params.id);

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (type && type !== appointment.type) {
      return res.status(400).json({ error: 'Cannot change appointment type' });
    }

    const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const dateStr = appointment.appointment_date.toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === appointment.doctor_id.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    if (appointment.type === 'time-based') {
      const newStartTime = start_time ? new Date(start_time) : appointment.start_time;
      const newDuration = duration || ((appointment.end_time - appointment.start_time) / 60000);
      const newEndTime = new Date(newStartTime.getTime() + newDuration * 60000);

      if (newStartTime.getTime() !== appointment.start_time.getTime() ||
        newEndTime.getTime() !== appointment.end_time.getTime()) {

        const otherAppointments = doctor.bookedAppointments.filter(
          a => a.appointmentId.toString() !== appointment._id.toString()
        );

        if (hasTimeConflict(otherAppointments, newStartTime, newEndTime)) {
          return res.status(400).json({ error: 'New time slot conflicts with existing appointments' });
        }

        const calendarAppointment = doctor.bookedAppointments.find(
          a => a.appointmentId.toString() === appointment._id.toString()
        );

        if (calendarAppointment) {
          calendarAppointment.startTime = newStartTime;
          calendarAppointment.endTime = newEndTime;
          calendarAppointment.duration = newDuration;
        }

        appointment.start_time = newStartTime;
        appointment.end_time = newEndTime;
      }
    } else {
      if (req.body.serial_number !== undefined) {
        const newSerialNumber = req.body.serial_number;

        const existingPatient = doctor.bookedPatients.find(
          p => p.serialNumber === newSerialNumber &&
            p.appointmentId.toString() !== appointment._id.toString()
        );

        if (existingPatient) {
          return res.status(400).json({ error: 'Serial number already assigned' });
        }

        const patientEntry = doctor.bookedPatients.find(
          p => p.appointmentId.toString() === appointment._id.toString()
        );

        if (patientEntry) {
          patientEntry.serialNumber = newSerialNumber;
        }

        appointment.serial_number = newSerialNumber;
      }
    }

    const { notes, priority, appointment_type, status } = req.body;

    if (notes !== undefined) appointment.notes = notes;
    if (priority !== undefined) appointment.priority = priority;
    if (appointment_type !== undefined) appointment.appointment_type = appointment_type;
    if (status !== undefined) appointment.status = status;

    await Promise.all([appointment.save(), calendar.save()]);
    res.json(appointment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete appointment
exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const dateStr = appointment.appointment_date.toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === appointment.doctor_id.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    if (appointment.type === 'time-based') {
      const appointmentIndex = doctor.bookedAppointments.findIndex(
        a => a.appointmentId.toString() === appointment._id.toString()
      );

      if (appointmentIndex !== -1) {
        const duration = (appointment.end_time - appointment.start_time) / 60000;
        doctor.bookedAppointments.splice(appointmentIndex, 1);

        for (let i = appointmentIndex; i < doctor.bookedAppointments.length; i++) {
          const appt = doctor.bookedAppointments[i];
          appt.startTime = new Date(appt.startTime.getTime() - duration * 60000);
          appt.endTime = new Date(appt.endTime.getTime() - duration * 60000);

          await Appointment.findByIdAndUpdate(appt.appointmentId, {
            start_time: appt.startTime,
            end_time: appt.endTime
          });
        }
      }
    } else {
      doctor.bookedPatients = doctor.bookedPatients.filter(
        p => p.appointmentId.toString() !== appointment._id.toString()
      );
    }

    await Promise.all([
      Appointment.findByIdAndDelete(req.params.id),
      calendar.save()
    ]);

    res.json({ message: 'Appointment deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get appointments by Doctor ID
exports.getAppointmentsByDoctorId = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const appointments = await Appointment.find({ doctor_id: doctorId })
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
    res.status(500).json({ error: err.message });
  }
};

// Get appointments by Department ID
exports.getAppointmentsByDepartmentId = async (req, res) => {
  try {
    const { departmentId } = req.params;
    const appointments = await Appointment.find({ department_id: departmentId })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this department' });
    }

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get appointments by Hospital ID
exports.getAppointmentsByHospitalId = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const appointments = await Appointment.find({ hospital_id: hospitalId })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id');

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this hospital' });
    }

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get today's appointments for a doctor
exports.getTodaysAppointmentsByDoctorId = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const appointments = await Appointment.find({
      doctor_id: doctorId,
      appointment_date: {
        $gte: today,
        $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      }
    })
      .populate('patient_id')
      .populate('doctor_id')
      .populate('department_id')
      .populate('hospital_id')
      .sort({ start_time: 1 });

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update appointment status
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { status } = req.body;

    const appointment = await Appointment.findByIdAndUpdate(
      req.params.id,
      { status: status },
      { new: true, runValidators: true }
    );

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (status === 'Completed') {
      try {
        await calculatePartTimeSalary(appointment._id);

        if (!appointment.actual_end_time) {
          appointment.actual_end_time = new Date();
          await appointment.save();
        }
      } catch (salaryError) {
        console.error('Error calculating part-time salary during status update:', salaryError);
      }
    }

    res.json(appointment);
  } catch (err) {
    console.error("Error updating appointment status:", err);
    res.status(500).json({ error: 'Server error while updating status' });
  }
};

// Update Vitals for an Appointment
exports.updateVitals = async (req, res) => {
  try {
    const { bp, weight, pulse, spo2, temperature, respiratory_rate, random_blood_sugar, height } = req.body;
    const appointmentId = req.params.id;

    const appointment = await Appointment.findById(appointmentId);
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
      vitalRecord.recorded_at = new Date();
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
    res.status(500).json({ error: err.message });
  }
};

// Get Vitals by Appointment ID
exports.getVitalsByAppointmentId = async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const vitals = await Vital.findOne({ appointment_id: appointmentId });
    res.json(vitals || null);
  } catch (err) {
    console.error("Error fetching vitals:", err);
    res.status(500).json({ error: err.message });
  }
};