const Appointment = require('../models/Appointment');

// Create a new appointment
exports.createAppointment = async (req, res) => {
  try {
    const appointment = new Appointment(req.body);
    await appointment.save();
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
      .populate('department_id');
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
      .populate('department_id');
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appointment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update appointment
exports.updateAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appointment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const appointment = await Appointment.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    
    res.json(appointment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete appointment
exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findByIdAndDelete(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
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
      .populate('department_id');

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
      .populate('department_id');

    if (appointments.length === 0) {
      return res.status(404).json({ error: 'No appointments found for this department' });
    }

    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

