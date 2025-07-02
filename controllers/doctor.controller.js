const Doctor = require('../models/Doctor');
const User = require('../models/User'); // ✅ import User model

// Create a new doctor
exports.createDoctor = async (req, res) => {
  try {
    const {
  firstName,
  lastName,
  email,
  password,
  phone,
  dateOfBirth,
  gender,
  address,
  city,
  state,
  zipCode,
  role,
  department,
  specialization,
  licenseNumber,
  experience,
  education,
  shift,
  emergencyContact,
  emergencyPhone,
  startDate,
  salary,
  isFullTime,
  hasInsurance,
  notes,
  paymentType,
  contractualSalary,
  feePerVisit,
  ratePerHour,
  contractStartDate,
  contractEndDate,
  visitsPerWeek,
  workingDaysPerWeek,
  timeSlots,
  aadharNumber,
  panNumber
} = req.body;


    // Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ error: 'User with this email already exists' });

    // ✅ Step 1: Create User (with password)
    const newUser = await User.create({
      name: `${firstName} ${lastName}`,
      email,
      password,
      role: role?.toLowerCase() || 'doctor',
    });

    // ✅ Step 2: Create Doctor (without password)
    const newDoctor = await Doctor.create({
  firstName,
  lastName,
  email,
  phone,
  dateOfBirth,
  gender,
  address,
  city,
  state,
  zipCode,
  role,
  department,
  specialization,
  licenseNumber,
  experience,
  education,
  shift,
  emergencyContact,
  emergencyPhone,
  startDate,
  salary,
  isFullTime,
  hasInsurance,
  notes,
  paymentType,
  contractualSalary,
  feePerVisit,
  ratePerHour,
  contractStartDate,
  contractEndDate,
  visitsPerWeek,
  workingDaysPerWeek,
  timeSlots,
  aadharNumber,
  panNumber
});


    res.status(201).json({
      message: 'Doctor and user created successfully',
      doctor: newDoctor,
      userId: newUser._id
    });

  } catch (err) {
    console.error('Doctor creation error:', err.message);
    res.status(400).json({ error: err.message });
  }
};


// Get all doctors
exports.getAllDoctors = async (req, res) => {
  try {
    const doctors = await Doctor.find();
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get a doctor by ID
exports.getDoctorById = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id).populate('department');
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    res.json(doctor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update a doctor by ID
exports.updateDoctor = async (req, res) => {
  try {
    const doctor = await Doctor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    res.json(doctor);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get doctors by department ID
exports.getDoctorsByDepartmentId = async (req, res) => {
  try {
    const { departmentId } = req.params;

    const doctors = await Doctor.find({ department: departmentId }).populate('department');
    
    if (!doctors.length) {
      return res.status(404).json({ error: 'No doctors found for this department' });
    }

    res.json(doctors);
  } catch (err) {
    console.error('Error fetching doctors by department:', err.message);
    res.status(500).json({ error: err.message });
  }
};


// Delete a doctor by ID
exports.deleteDoctor = async (req, res) => {
  try {
    const doctor = await Doctor.findByIdAndDelete(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ message: 'Doctor deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
