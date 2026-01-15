// const Calendar = require('../models/Calendar');
// const { default: mongoose } = require('mongoose');

// // Book a slot
// const bookSlot = async (req, res) => {
//   try {
//     const { hospitalId, date, doctorId, slot } = req.body;
//     const calendar = await Calendar.findOne({ hospitalId });
//     if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

//     const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
//     if (!day) return res.status(404).json({ message: 'Date not found' });

//     const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
//     if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

//     if (!doctor.availableSlots.includes(slot)) {
//       return res.status(400).json({ message: 'Slot not available' });
//     }

//     doctor.availableSlots = doctor.availableSlots.filter(s => s !== slot);
//     doctor.bookedSlots.push(slot);

//     await calendar.save();
//     res.json({ message: 'Slot booked successfully' });
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// };

// // Cancel a booking
// const cancelBooking = async (req, res) => {
//   try {
//     const { hospitalId, date, doctorId, slot } = req.body;
//     const calendar = await Calendar.findOne({ hospitalId });
//     if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

//     const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
//     if (!day) return res.status(404).json({ message: 'Date not found' });

//     const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId);
//     if (!doctor) return res.status(404).json({ message: 'Doctor not found' });

//     if (!doctor.bookedSlots.includes(slot)) {
//       return res.status(400).json({ message: 'Slot not booked' });
//     }

//     doctor.bookedSlots = doctor.bookedSlots.filter(s => s !== slot);
//     doctor.availableSlots.push(slot);

//     await calendar.save();
//     res.json({ message: 'Booking cancelled successfully' });
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// };

// // Get full doctor's calendar across all days
// const getDoctorCalendar = async (req, res) => {
//   try {
//     const { doctorId } = req.params;

//     if (!mongoose.Types.ObjectId.isValid(doctorId)) {
//       return res.status(400).json({ message: 'Invalid doctorId format' });
//     }

//     const calendars = await Calendar.find({
//       'days.doctors.doctorId': new mongoose.Types.ObjectId(doctorId)
//     }).populate('days.doctors.doctorId');

//     if (!calendars.length) {
//       return res.status(404).json({ message: 'No calendar found for this doctor' });
//     }

//     const doctorSchedule = calendars.map(calendar => ({
//       hospitalId: calendar.hospitalId,
//       days: calendar.days
//         .map(day => ({
//           date: day.date,
//           dayName: day.dayName,
//           doctor: day.doctors.find(doc => {
//             const id = doc.doctorId?._id || doc.doctorId;
//             return id.toString() === doctorId;
//           }) || null
//         }))
//     }));

//     res.json(doctorSchedule);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: err.message });
//   }
// };

// // GET all calendar data for a hospital
// const getHospitalCalendar = async (req, res) => {
//   try {
//     const { hospitalId } = req.params;
//     const calendar = await Calendar.findOne({ hospitalId }).populate('days.doctors.doctorId');
//     res.json(calendar);
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// };

// // GET doctor's data for today at a specific hospital
// const getTodayDoctorData = async (req, res) => {
//   try {
//     const { hospitalId, doctorId } = req.params;

//     const today = new Date().toISOString().split('T')[0];
//     const calendar = await Calendar.findOne({ hospitalId });
//     if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

//     const todayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === today);
//     if (!todayData) return res.status(404).json({ message: 'No data for today' });

//     const doctorData = todayData.doctors.find(d => d.doctorId.toString() === doctorId);
//     if (!doctorData) return res.status(404).json({ message: 'Doctor not available today' });

//     res.json(doctorData);
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// };

// // GET specific day data for a hospital
// const getDayData = async (req, res) => {
//   try {
//     const { hospitalId, date } = req.params;
//     const calendar = await Calendar.findOne({ hospitalId });
//     if (!calendar) return res.status(404).json({ message: 'Calendar not found' });

//     const dayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
//     res.json(dayData || { message: 'No data for this date' });
//   } catch (err) {
//     res.status(500).json({ message: err.message });
//   }
// };

// module.exports = {
//   bookSlot,
//   cancelBooking,
//   getDoctorCalendar,
//   getHospitalCalendar,
//   getTodayDoctorData,
//   getDayData
// };

const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const mongoose = require('mongoose');

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

    const dateStr = appointment.appointment_date.toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
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

// Add break for a doctor
exports.addDoctorBreak = async (req, res) => {
  try {
    const { doctorId, hospitalId, date, startTime, endTime, reason } = req.body;

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const dateStr = new Date(date).toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    const breakStart = new Date(startTime);
    const breakEnd = new Date(endTime);
    const breakDuration = (breakEnd - breakStart) / 60000;

    // 🚫 Prevent overlapping breaks
    if (hasTimeConflict([], breakStart, breakEnd, doctor.breaks)) {
      return res.status(400).json({ error: 'Break overlaps with existing break' });
    }

    doctor.breaks.push({
      startTime: breakStart,
      endTime: breakEnd,
      reason: reason || 'Break'
    });

    // ⏱ Handle overlapping appointments
    const overlappingAppointments = doctor.bookedAppointments.filter(appt =>
      appt.startTime < breakEnd && appt.endTime > breakStart
    );

    for (const appt of overlappingAppointments) {
      // Cancel overlapping appointments
      appt.status = 'Cancelled';
      await Appointment.findByIdAndUpdate(appt.appointmentId, { status: 'Cancelled' });
    }

    // Shift all appointments after the break
    for (const appt of doctor.bookedAppointments) {
      if (appt.startTime >= breakEnd) {
        appt.startTime = new Date(appt.startTime.getTime() + breakDuration * 60000);
        appt.endTime = new Date(appt.endTime.getTime() + breakDuration * 60000);

        await Appointment.findByIdAndUpdate(appt.appointmentId, {
          start_time: appt.startTime,
          end_time: appt.endTime
        });
      }
    }

    await calendar.save();
    res.json({ message: 'Break added, conflicts cancelled, and appointments shifted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get doctor's schedule for a specific day
exports.getDoctorDaySchedule = async (req, res) => {
  try {
    const { hospitalId, doctorId, date } = req.params;

    const calendar = await Calendar.findOne({ hospitalId });
    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const dateStr = new Date(date).toISOString().split('T')[0];
    const day = calendar.days.find(d => d.date.toISOString().split('T')[0] === dateStr);
    if (!day) return res.status(404).json({ error: 'Day not found in calendar' });

    const doctor = day.doctors.find(d => d.doctorId.toString() === doctorId.toString());
    if (!doctor) return res.status(404).json({ error: 'Doctor not found on this day' });

    // Get all appointments for this doctor on this day
    const appointments = await Appointment.find({
      doctor_id: doctorId,
      appointment_date: {
        $gte: new Date(dateStr + 'T00:00:00.000Z'),
        $lt: new Date(dateStr + 'T23:59:59.999Z')
      }
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
    doctorSchedule.sort((a, b) => new Date(a.date) - new Date(b.date));

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

    const today = new Date().toISOString().split('T')[0];
    const calendar = await Calendar.findOne({ hospitalId })
      .populate('days.doctors.doctorId')
      .populate('days.doctors.bookedAppointments.appointmentId')
      .populate('days.doctors.bookedPatients.patientId');

    if (!calendar) return res.status(404).json({ error: 'Calendar not found' });

    const todayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === today);
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

    const dayData = calendar.days.find(d => d.date.toISOString().split('T')[0] === date);
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

    const dateObj = new Date(date);
    const dateStr = dateObj.toISOString().split('T')[0];
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });

    // Check if day already exists
    const dayExists = calendar.days.some(d => d.date.toISOString().split('T')[0] === dateStr);
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