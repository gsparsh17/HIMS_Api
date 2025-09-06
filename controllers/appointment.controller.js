const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');
const mongoose = require('mongoose');
const { calculatePartTimeSalary } = require('../controllers/salary.controller');

// In your appointment completion function
// In your appointment completion function
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

    // Calculate salary for part-time doctors
    try {
      await calculatePartTimeSalary(appointment._id);
    } catch (salaryError) {
      console.error('Error calculating part-time salary:', salaryError);
      // You can choose to proceed even if salary calculation fails
    }

    res.json({ message: 'Appointment status updated to Completed', appointment });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Helper function to check for time slot conflicts
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

// ✅ Create Appointment
exports.createAppointment = async (req, res) => {
  try {
    const { type, doctor_id, hospital_id, department_id, appointment_date, duration = 30 } = req.body;

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
        return res.status(400).json({ error: 'Time slot not available (conflict with appointment or break)' });
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
      // Number-based booking
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
      .populate('hospital_id');
    res.json(appointments);
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
    res.json(appointment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update appointment (basic details - not status)
exports.updateAppointment = async (req, res) => {
  try {
    const { type, start_time, duration } = req.body;
    const appointment = await Appointment.findById(req.params.id);
    
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Don't allow changing appointment type
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
      // Handle time changes for time-based appointments
      const newStartTime = start_time ? new Date(start_time) : appointment.start_time;
      const newDuration = duration || ((appointment.end_time - appointment.start_time) / 60000);
      const newEndTime = new Date(newStartTime.getTime() + newDuration * 60000);

      // Check if time is being changed
      if (newStartTime.getTime() !== appointment.start_time.getTime() || 
          newEndTime.getTime() !== appointment.end_time.getTime()) {
        
        // Check for conflicts (excluding current appointment)
        const otherAppointments = doctor.bookedAppointments.filter(
          a => a.appointmentId.toString() !== appointment._id.toString()
        );
        
        if (hasTimeConflict(otherAppointments, newStartTime, newEndTime)) {
          return res.status(400).json({ error: 'New time slot conflicts with existing appointments' });
        }

        // Update calendar appointment
        const calendarAppointment = doctor.bookedAppointments.find(
          a => a.appointmentId.toString() === appointment._id.toString()
        );
        
        if (calendarAppointment) {
          calendarAppointment.startTime = newStartTime;
          calendarAppointment.endTime = newEndTime;
          calendarAppointment.duration = newDuration;
        }

        // Update appointment document
        appointment.start_time = newStartTime;
        appointment.end_time = newEndTime;
      }
    } else {
      // For number-based appointments, only allow updating serial number if explicitly provided
      if (req.body.serial_number !== undefined) {
        const newSerialNumber = req.body.serial_number;
        
        // Check if serial number is already taken
        const existingPatient = doctor.bookedPatients.find(
          p => p.serialNumber === newSerialNumber && 
               p.appointmentId.toString() !== appointment._id.toString()
        );
        
        if (existingPatient) {
          return res.status(400).json({ error: 'Serial number already assigned' });
        }

        // Update in calendar
        const patientEntry = doctor.bookedPatients.find(
          p => p.appointmentId.toString() === appointment._id.toString()
        );
        
        if (patientEntry) {
          patientEntry.serialNumber = newSerialNumber;
        }

        appointment.serial_number = newSerialNumber;
      }
    }

    // Update other fields
    const { notes, priority, appointment_type } = req.body;
    if (notes !== undefined) appointment.notes = notes;
    if (priority !== undefined) appointment.priority = priority;
    if (appointment_type !== undefined) appointment.appointment_type = appointment_type;

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
      // Remove from bookedAppointments
      const appointmentIndex = doctor.bookedAppointments.findIndex(
        a => a.appointmentId.toString() === appointment._id.toString()
      );
      
      if (appointmentIndex !== -1) {
        // Get the duration to adjust subsequent appointments
        const duration = (appointment.end_time - appointment.start_time) / 60000;
        
        // Remove the appointment
        doctor.bookedAppointments.splice(appointmentIndex, 1);
        
        // Adjust subsequent appointments
        for (let i = appointmentIndex; i < doctor.bookedAppointments.length; i++) {
          const appt = doctor.bookedAppointments[i];
          appt.startTime = new Date(appt.startTime.getTime() - duration * 60000);
          appt.endTime = new Date(appt.endTime.getTime() - duration * 60000);
          
          // Update the appointment document
          await Appointment.findByIdAndUpdate(appt.appointmentId, {
            start_time: appt.startTime,
            end_time: appt.endTime
          });
        }
      }
    } else {
      // Remove from bookedPatients
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

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this doctor' });
    }

    res.json(appointments);
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