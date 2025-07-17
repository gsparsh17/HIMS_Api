const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');

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
  // role,
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
      role: 'doctor',
    });

    // ✅ Step 2: Create Doctor (without password)
    const newDoctor = await Doctor.create({
  user_id: newUser._id, // Link doctor with user account
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
  // role,
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
    const doctors = await Doctor.find().populate('department').populate('user_id', 'name email role');
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get a doctor by ID
exports.getDoctorById = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id).populate('department').populate('user_id', 'name email role');
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

    const doctors = await Doctor.find({ department: departmentId }).populate('department').populate('user_id', 'name email role');

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
// exports.bulkCreateDoctors = async (req, res) => {
//   const doctorsData = req.body; // Array of doctors from the parsed CSV
//   console.log('Bulk import data:', doctorsData);
//   if (!doctorsData || !Array.isArray(doctorsData)) {
//     return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
//   }

//   const successfulImports = [];
//   const failedImports = [];

//   // Use a for...of loop to process each record sequentially
//   for (const doctor of doctorsData) {
//     try {
//       // 1. Check if user already exists
//       const userExists = await User.findOne({ email: doctor.email });
//       if (userExists) {
//         throw new Error('User with this email already exists.');
//       }

//       // 2. Create the User record for authentication
//       const newUser = await User.create({
//         name: `${doctor.firstName} ${doctor.lastName}`,
//         email: doctor.email,
//         password: doctor.password, // Password comes from the CSV
//         role: 'doctor',
//       });

//       console.log(newUser)

//       // 3. Create the Doctor profile record
//       const newDoctor = await Doctor.create({
//         ...doctor, // Pass all fields from the CSV row
//       });
      
//       successfulImports.push(newDoctor);
//       console.log(`Successfully imported doctor: ${newDoctor.firstName} ${newDoctor.lastName}`);
//     } catch (err) {
//       // If any step fails, add it to the failed list and continue
//       failedImports.push({
//         email: doctor.email,
//         reason: err.message,
//       });
//     }
//   }

//   // 4. Send a summary response
//   res.status(201).json({
//     message: 'Bulk import process completed.',
//     successfulCount: successfulImports.length,
//     failedCount: failedImports.length,
//     failedImports: failedImports,
//   });
// };

exports.bulkCreateDoctors = async (req, res) => {
  const doctorsData = req.body; // Array of doctors from the parsed CSV
  console.log('Bulk import data:', doctorsData);

  if (!doctorsData || !Array.isArray(doctorsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];

  for (const doctor of doctorsData) {
    try {
      // ✅ 1. Check if user already exists
      const userExists = await User.findOne({ email: doctor.email });
      if (userExists) {
        throw new Error('User with this email already exists.');
      }

      // ✅ 2. Resolve department name to ObjectId
      let departmentId = null;
      if (doctor.department) {
        const dept = await Department.findOne({ name: new RegExp(`^${doctor.department}$`, 'i') });
        if (!dept) {
          throw new Error(`Department "${doctor.department}" not found.`);
        }
        departmentId = dept._id;
        console.log(`Resolved department "${doctor.department}" to ID ${departmentId}`);
      }

      // ✅ 3. Create the User record for authentication
      const newUser = await User.create({
        name: `${doctor.firstName} ${doctor.lastName}`,
        email: doctor.email,
        password: doctor.password,
        role: 'doctor',
      });

      // ✅ 4. Create the Doctor profile record
      // const newDoctor = await Doctor.create({
      //   ...doctor,
      //   department: departmentId, // Replace name with ObjectId
      //   user_id: newUser._id, // Optional: link doctor with user account
      // });

      const newDoctor = await Doctor.create({
  user_id: newUser._id,
  firstName: doctor.firstName,
  lastName: doctor.lastName,
  email: doctor.email,
  phone: doctor.phone,
  // role: 'Doctor',
  department: departmentId,
  specialization: doctor.specialization || '',
  licenseNumber: doctor.licenseNumber,
  experience: doctor.experience ? Number(doctor.experience) : null,
  paymentType: doctor.paymentType || null,
  dateOfBirth: doctor.dateOfBirth ? new Date(doctor.dateOfBirth.replace(/-/g, '/')) : null,
  gender: doctor.gender?.toLowerCase(),
  address: doctor.address || '',
  city: doctor.city || '',
  state: doctor.state || '',
  zipCode: doctor.zipCode || '',
  aadharNumber: doctor.aadharNumber || null,
  panNumber: doctor.panNumber || null,
});

      console.log(newDoctor);

      successfulImports.push(newDoctor);
      console.log(`Successfully imported doctor: ${newDoctor.firstName} ${newDoctor.lastName}`);
    } catch (err) {
      failedImports.push({
        email: doctor.email,
        reason: err.message,
      });
    }
  }

  // ✅ 5. Send summary response
  res.status(201).json({
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    failedImports: failedImports,
  });
};
