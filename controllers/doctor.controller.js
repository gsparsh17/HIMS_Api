const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital'); // 👈 1. Import Hospital model
const Calendar = require('../models/Calendar'); // 👈 2. Import Calendar model

// ✅ Create a new doctor
exports.createDoctor = async (req, res) => {
  try {
    const {
      firstName, lastName, email, password, /* ...all other fields... */
      isFullTime, contractStartDate, contractEndDate, aadharNumber, panNumber
    } = req.body;

    // ✅ Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ error: 'User with this email already exists' });

    // ✅ Create User
    const newUser = await User.create({
      name: `${firstName} ${lastName}`,
      email,
      password,
      role: 'doctor'
    });

    // ✅ Create Doctor
    const newDoctor = await Doctor.create({
      user_id: newUser._id,
      firstName,
      lastName,
      email,
      phone: req.body.phone,
      dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null,
      gender: req.body.gender,
      address: req.body.address,
      city: req.body.city,
      state: req.body.state,
      zipCode: req.body.zipCode,
      department: req.body.department,
      specialization: req.body.specialization,
      licenseNumber: req.body.licenseNumber,
      experience: req.body.experience ? Number(req.body.experience) : null,
      education: req.body.education,
      shift: req.body.shift,
      emergencyContact: req.body.emergencyContact,
      emergencyPhone: req.body.emergencyPhone,
      startDate: req.body.startDate ? new Date(req.body.startDate) : null,
      isFullTime: isFullTime === true || isFullTime === 'true',
      notes: req.body.notes,
      paymentType: req.body.paymentType,
      amount: req.body.amount ? Number(req.body.amount) : null,
      contractStartDate: contractStartDate ? new Date(contractStartDate) : null,
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      visitsPerWeek: req.body.visitsPerWeek ? Number(req.body.visitsPerWeek) : null,
      workingDaysPerWeek: req.body.workingDaysPerWeek ? req.body.workingDaysPerWeek : null,
      timeSlots: req.body.timeSlots || [],
      aadharNumber,
      panNumber
    });
    
    // 👇 3. Immediately add the new doctor to all existing calendars
    try {
      console.log('🗓️  Adding new doctor to calendars...');
      // NOTE: This assumes a new doctor should be added to ALL hospital calendars.
      // For a single hospital, you'd need to pass a hospitalId in the request.
      const hospitals = await Hospital.find();

      for (const hospital of hospitals) {
        // Use $push to add the new doctor to each relevant day in one operation
        await Calendar.updateOne(
          { hospitalId: hospital._id },
          {
            $push: {
              'days.$[day].doctors': {
                doctorId: newDoctor._id,
                bookedAppointments: [],
                bookedPatients: [],
                breaks: []
              }
            }
          },
          {
            arrayFilters: [
              {
                // Condition 1: Add to days where the doctor is not already present
                'day.doctors.doctorId': { $ne: newDoctor._id },
                // Condition 2: Add only if doctor is Full-Time OR the day is within their Part-Time contract
                ...(newDoctor.isFullTime
                  ? {} // If full-time, no date filter is needed
                  : { 'day.date': { $gte: newDoctor.contractStartDate, $lte: newDoctor.contractEndDate } }
                )
              }
            ]
          }
        );
      }
      console.log(`✅ Finished calendar update for Doctor ${newDoctor.firstName}`);
    } catch (calendarError) {
      console.error('❌ Failed to update calendar with new doctor:', calendarError);
      // Log the error, but don't block the API response
    }

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

exports.bulkCreateDoctors = async (req, res) => {
  const doctorsData = req.body;
  console.log('Bulk import data:', doctorsData);

  if (!doctorsData || !Array.isArray(doctorsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];

  for (const doctor of doctorsData) {
    try {
      // ✅ Check if user already exists
      const userExists = await User.findOne({ email: doctor.email });
      if (userExists) throw new Error('User with this email already exists.');

      // ✅ Resolve department name
      let departmentId = null;
      if (doctor.department) {
        const dept = await Department.findOne({ name: new RegExp(`^${doctor.department}$`, 'i') });
        if (!dept) throw new Error(`Department "${doctor.department}" not found.`);
        departmentId = dept._id;
      }

      // ✅ Create User
      const newUser = await User.create({
        name: `${doctor.firstName} ${doctor.lastName}`,
        email: doctor.email,
        password: doctor.password,
        role: 'doctor'
      });

      // ✅ Create Doctor
      const newDoctor = await Doctor.create({
        user_id: newUser._id,
        firstName: doctor.firstName,
        lastName: doctor.lastName,
        email: doctor.email,
        phone: doctor.phone,
        dateOfBirth: doctor.dateOfBirth ? new Date(doctor.dateOfBirth.replace(/-/g, '/')) : null,
        gender: doctor.gender?.toLowerCase(),
        address: doctor.address || '',
        city: doctor.city || '',
        state: doctor.state || '',
        zipCode: doctor.zipCode || '',
        department: departmentId,
        specialization: doctor.specialization || '',
        licenseNumber: doctor.licenseNumber || '',
        experience: doctor.experience ? Number(doctor.experience) : null,
        paymentType: doctor.paymentType || null,
        amount: doctor.amount ? Number(doctor.amount) : null,
        isFullTime: doctor.isFullTime === 'true' || doctor.isFullTime === true,
        contractStartDate: doctor.contractStartDate ? new Date(doctor.contractStartDate) : null,
        contractEndDate: doctor.contractEndDate ? new Date(doctor.contractEndDate) : null,
        visitsPerWeek: doctor.visitsPerWeek ? Number(doctor.visitsPerWeek) : null,
        workingDaysPerWeek: doctor.workingDaysPerWeek ? Number(doctor.workingDaysPerWeek) : null,
        aadharNumber: doctor.aadharNumber || null,
        panNumber: doctor.panNumber || null,
        notes: doctor.notes || ''
      });

      successfulImports.push(newDoctor);
    } catch (err) {
      failedImports.push({ email: doctor.email, reason: err.message });
    }
  }

  res.status(201).json({
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    failedImports
  });
};
