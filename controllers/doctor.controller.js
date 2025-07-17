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

// Bulk create doctors
exports.bulkCreateDoctors = async (req, res) => {
  const doctorsData = req.body; // Array of doctors from the parsed CSV

  if (!doctorsData || !Array.isArray(doctorsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];

  // Use a for...of loop to process each record sequentially
  for (const doctor of doctorsData) {
    try {
      // 1. Check if user already exists
      const userExists = await User.findOne({ email: doctor.email });
      if (userExists) {
        throw new Error('User with this email already exists.');
      }

      // 2. Create the User record for authentication
      const newUser = await User.create({
        name: `${doctor.firstName} ${doctor.lastName}`,
        email: doctor.email,
        password: doctor.password, // Password comes from the CSV
        role: doctor.role?.toLowerCase() || 'doctor',
      });

      // 3. Create the Doctor profile record
      const newDoctor = await Doctor.create({
        ...doctor, // Pass all fields from the CSV row
      });
      
      successfulImports.push(newDoctor);

    } catch (err) {
      // If any step fails, add it to the failed list and continue
      failedImports.push({
        email: doctor.email,
        reason: err.message,
      });
    }
  }

  // 4. Send a summary response
  res.status(201).json({
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    failedImports: failedImports,
  });
};
