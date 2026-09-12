const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const CalendarEvent = require('../models/CalendarEvent');
const { requireHospitalId } = require('../services/tenantScope.service');
const mongoose = require('mongoose');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalDateKey,
  hospitalTodayKey,
  hospitalDayBounds,
  parseHospitalDateTime,
  calendarDayKey,
  dateKeyToStorageDate,
  dateKeyDayName
} = require('../utils/hospitalDateTime');

function hasTimeConflict(appointments, startTime, endTime, breaks = []) {
  // check against appointments
  for (const appt of appointments) {
    if (
      (startTime >= appt.startTime && startTime < appt.endTime) ||
      (endTime > appt.startTime && endTime <= appt.endTime) ||
      (startTime <= appt.startTime && endTime >= appt.endTime)
    ) {
      return true;
    }
  }

  // check against breaks
  for (const brk of breaks) {
    if (
      (startTime >= brk.startTime && startTime < brk.endTime) ||
      (endTime > brk.startTime && endTime <= brk.endTime) ||
      (startTime <= brk.startTime && endTime >= brk.endTime)
    ) {
      return true;
    }
  }

  return false;
}

// Helper function to adjust subsequent appointments
const adjustSubsequentAppointments = async (calendar, day, doctor, updatedAppointmentId, timeChange) => {
  const appointments = doctor.bookedAppointments.sort((a, b) => a.startTime - b.startTime);
  const updatedIndex = appointments.findIndex(a => a.appointmentId.toString() === updatedAppointmentId.toString());
  
  if (updatedIndex === -1 || updatedIndex === appointments.length - 1) return;

  // Update all subsequent appointments
  for (let i = updatedIndex + 1; i < appointments.length; i++) {
    const appt = appointments[i];
    appt.startTime = new Date(appt.startTime.getTime() + timeChange * 60000);
    appt.endTime = new Date(appt.endTime.getTime() + timeChange * 60000);
    
    // Update the corresponding appointment document
    await Appointment.findByIdAndUpdate(appt.appointmentId, {
      start_time: appt.startTime,
      end_time: appt.endTime
    });
  }

  await calendar.save();
};

// Update appointment status with time adjustment
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { appointmentId, status } = req.body;
    const appointment = await Appointment.findById(appointmentId);
    
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const calendar = await Calendar.findOne({ hospitalId: appointment.hospital_id });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateStr = appointment.appointment_date_key || hospitalDateKey(appointment.appointment_date, timeZone);
    const day = calendar.days.find((d) => calendarDayKey(d, timeZone) === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === appointment.doctor_id.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    const calendarAppointment = doctor.bookedAppointments.find(a => 
      a.appointmentId.toString() === appointmentId.toString()
    );
    
    if (!calendarAppointment) {
      return res.status(404).json({ error: 'Appointment not found in calendar' });
    }

    // Handle status changes
    if (status === 'InProgress' && calendarAppointment.status === 'Scheduled') {
      calendarAppointment.status = 'InProgress';
      appointment.actual_start_time = new Date();
      appointment.status = 'InProgress';
    } 
    else if (status === 'Completed' && calendarAppointment.status === 'InProgress') {
      calendarAppointment.status = 'Completed';
      appointment.actual_end_time = new Date();
      appointment.status = 'Completed';
      
      // Calculate actual duration
      if (appointment.actual_start_time) {
        appointment.duration = Math.round(
          (appointment.actual_end_time - appointment.actual_start_time) / 60000
        );
        
        // Calculate time difference from scheduled duration
        const scheduledDuration = (appointment.end_time - appointment.start_time) / 60000;
        const timeDifference = appointment.duration - scheduledDuration;
        
        // Adjust subsequent appointments if needed
        if (Math.abs(timeDifference) > 5) { // Only adjust if difference > 5 minutes
          await adjustSubsequentAppointments(
            calendar,
            day,
            doctor,
            appointmentId,
            timeDifference
          );
        }
      }
    }
    else if (status === 'Cancelled') {
      calendarAppointment.status = 'Cancelled';
      appointment.status = 'Cancelled';
      
      // For time-based appointments, adjust subsequent appointments
      if (appointment.type === 'time-based') {
        const duration = (appointment.end_time - appointment.start_time) / 60000;
        await adjustSubsequentAppointments(
          calendar,
          day,
          doctor,
          appointmentId,
          -duration
        );
      }
      
      // Remove from bookedAppointments
      doctor.bookedAppointments = doctor.bookedAppointments.filter(
        a => a.appointmentId.toString() !== appointmentId.toString()
      );
    }

    await Promise.all([calendar.save(), appointment.save()]);
    res.json({ message: 'Appointment status updated successfully', appointment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Add break for a doctor. CalendarEvent is authoritative; the legacy embedded
// calendar is updated when present for backwards-compatible screens.
exports.addDoctorBreak = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { doctorId, date, startTime, endTime, reason } = req.body;
    const calendar = await Calendar.findOne({ hospitalId });
    const timeZone = calendar?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateStr = hospitalDateKey(date, timeZone);
    const breakStart = parseHospitalDateTime(startTime, dateStr, timeZone);
    const breakEnd = parseHospitalDateTime(endTime, dateStr, timeZone);
    if (breakEnd <= breakStart) return res.status(400).json({ error: 'Break end time must be after start time' });

    const duplicate = await CalendarEvent.exists({
      hospital_id: hospitalId, doctor_id: doctorId, date_key: dateStr, type: 'BREAK',
      start_time: String(startTime).slice(0,5), end_time: String(endTime).slice(0,5), is_active: { $ne: false }
    });
    if (duplicate) return res.status(409).json({ error: 'This break already exists' });

    const event = await CalendarEvent.create({
      hospital_id: hospitalId, doctor_id: doctorId, date_key: dateStr, type: 'BREAK',
      start_time: String(startTime).slice(0,5), end_time: String(endTime).slice(0,5), timezone: timeZone,
      reason: reason || 'Break', created_by: req.user?._id, updated_by: req.user?._id
    });

    if (calendar) {
      const day = calendar.days.find((d) => calendarDayKey(d, timeZone) === dateStr);
      const doctor = day?.doctors?.find((d) => d.doctorId.toString() === String(doctorId));
      if (doctor && !hasTimeConflict([], breakStart, breakEnd, doctor.breaks)) {
        doctor.breaks.push({ startTime: breakStart, endTime: breakEnd, reason: reason || 'Break' });
        await calendar.save().catch((legacyError) => console.warn('Legacy calendar break sync warning:', legacyError.message));
      }
    }

    res.status(201).json({ message: 'Doctor break added', event });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get doctor's schedule for a specific day
exports.getDoctorDaySchedule = async (req, res) => {
  try {
    const { hospitalId, doctorId, date } = req.params;

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateStr = hospitalDateKey(date, timeZone);
    const day = calendar.days.find((d) => calendarDayKey(d, timeZone) === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    const { start, end } = hospitalDayBounds(dateStr, timeZone);
    // appointment_date remains a compatibility Date sentinel, so use hospital-local
    // bounds to include both legacy and normalized rows during rollout.
    const appointments = await Appointment.find({
      hospital_id: hospitalId,
      doctor_id: doctorId,
      $or: [
        { appointment_date_key: dateStr },
        { appointment_date: { $gte: start, $lt: end } }
      ]
    }).populate('patient_id');

    // Combine calendar data with appointment details
    const response = {
      date: day.date,
      dayName: day.dayName,
      doctorId: doctor.doctorId,
      bookedAppointments: doctor.bookedAppointments.map(appt => {
        const fullAppointment = appointments.find(a => 
          a._id.toString() === appt.appointmentId.toString()
        );
        return {
          ...appt.toObject(),
          patient: fullAppointment ? fullAppointment.patient_id : null,
          appointmentDetails: fullAppointment || null
        };
      }),
      bookedPatients: doctor.bookedPatients.map(patient => {
        const fullAppointment = appointments.find(a => 
          a._id.toString() === patient.appointmentId.toString()
        );
        return {
          ...patient.toObject(),
          patientDetails: fullAppointment ? fullAppointment.patient_id : null,
          appointmentDetails: fullAppointment || null
        };
      }),
      breaks: doctor.breaks
    };

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get all calendar data for a hospital
exports.getHospitalCalendar = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const calendar = await Calendar.findOne({ hospitalId })
      .populate('days.doctors.doctorId')
      .populate('days.doctors.bookedAppointments.appointmentId')
      .populate('days.doctors.bookedPatients.patientId');

    if (!calendar) {
      return res.status(404).json({ error: 'Calendar not found' });
    }

    res.json(calendar);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get full doctor's calendar across all days
exports.getDoctorCalendar = async (req, res) => {
  try {
    const { doctorId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: 'Invalid doctorId format' });
    }

    const calendars = await Calendar.find({
      'days.doctors.doctorId': new mongoose.Types.ObjectId(doctorId)
    })
    .populate('days.doctors.doctorId')
    .populate('days.doctors.bookedAppointments.appointmentId')
    .populate('days.doctors.bookedPatients.patientId');

    if (!calendars.length) {
      return res.status(404).json({ error: 'No calendar found for this doctor' });
    }

    // Combine all days from all calendars where this doctor appears
    const doctorSchedule = [];
    calendars.forEach(calendar => {
      calendar.days.forEach(day => {
        const doctorDay = day.doctors.find(doc => {
          const id = doc.doctorId?._id || doc.doctorId;
          return id ? id.toString() === doctorId : false;
        });
        
        if (doctorDay) {
          doctorSchedule.push({
            hospitalId: calendar.hospitalId,
            date: day.date,
            dayName: day.dayName,
            doctor: doctorDay
          });
        }
      });
    });

    // Sort by date
    doctorSchedule.sort((a, b) => hospitalDateKey(a.date).localeCompare(hospitalDateKey(b.date)));

    res.json(doctorSchedule);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Get today's data for a specific doctor at a hospital
exports.getTodayDoctorData = async (req, res) => {
  try {
    const { hospitalId, doctorId } = req.params;

    const calendar = await Calendar.findOne({ hospitalId })
      .populate('days.doctors.doctorId')
      .populate('days.doctors.bookedAppointments.appointmentId')
      .populate('days.doctors.bookedPatients.patientId');

    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const today = hospitalTodayKey(timeZone);
    const todayData = calendar.days.find((d) => calendarDayKey(d, timeZone) === today);
    if (!todayData) return res.status(404).json({ error: 'No data for today' });

    const doctorData = todayData.doctors.find(d => d.doctorId.toString() === doctorId.toString());
    if (!doctorData) return res.status(404).json({ error: 'Doctor not available today' });

    res.json(doctorData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get specific day data for a hospital
exports.getDayData = async (req, res) => {
  try {
    const { hospitalId, date } = req.params;
    const calendar = await Calendar.findOne({ hospitalId })
      .populate('days.doctors.doctorId')
      .populate('days.doctors.bookedAppointments.appointmentId')
      .populate('days.doctors.bookedPatients.patientId');

    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateKey = hospitalDateKey(date, timeZone);
    const dayData = calendar.days.find((d) => calendarDayKey(d, timeZone) === dateKey);
    if (!dayData) return res.status(404).json({ error: 'No data for this date' });

    res.json(dayData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Initialize calendar for a new day
exports.initializeDay = async (req, res) => {
  try {
    const { hospitalId, date } = req.body;
    
    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const timeZone = calendar.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    const dateStr = hospitalDateKey(date, timeZone);
    const dateObj = dateKeyToStorageDate(dateStr);
    const dayName = dateKeyDayName(dateStr);

    // Check if day already exists, including legacy 18:30Z local-midnight rows.
    const dayExists = calendar.days.some((d) => calendarDayKey(d, timeZone) === dateStr);
    if (dayExists) {
      return res.status(400).json({ error: 'Day already exists in calendar' });
    }

    // Keep only latest 30 days
    if (calendar.days.length >= 30) {
      calendar.days.shift();
    }

    // Add new day with empty doctor schedules
    calendar.days.push({
      date: dateObj,
      dateKey: dateStr,
      dayName,
      doctors: [] // Doctors will be added when they have appointments
    });

    await calendar.save();
    res.json({ message: 'Day initialized successfully', calendar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = exports;