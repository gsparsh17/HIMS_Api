const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');

// ✅ Create a new doctor
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
      department,
      specialization,
      licenseNumber,
      experience,
      education,
      shift,
      emergencyContact,
      emergencyPhone,
      startDate,
      isFullTime,
      notes,
      paymentType,
      amount,
      contractStartDate,
      contractEndDate,
      visitsPerWeek,
      workingDaysPerWeek,
      timeSlots,
      aadharNumber,
      panNumber
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

    // ✅ Resolve department name to ObjectId
    // let departmentId = null;
    // if (department) {
    //   const dept = await Department.findOne({ name: new RegExp(`^${department}$`, 'i') });
    //   if (!dept) return res.status(400).json({ error: `Department "${department}" not found.` });
    //   departmentId = dept._id;
    // }

    // ✅ Create Doctor
    const newDoctor = await Doctor.create({
      user_id: newUser._id,
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      gender,
      address,
      city,
      state,
      zipCode,
      department,
      specialization,
      licenseNumber,
      experience: experience ? Number(experience) : null,
      education,
      shift,
      emergencyContact,
      emergencyPhone,
      startDate: startDate ? new Date(startDate) : null,
      isFullTime: isFullTime === true || isFullTime === 'true',
      notes,
      paymentType,
      amount: amount ? Number(amount) : null,
      contractStartDate: contractStartDate ? new Date(contractStartDate) : null,
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      visitsPerWeek: visitsPerWeek ? Number(visitsPerWeek) : null,
      workingDaysPerWeek: workingDaysPerWeek ? Number(workingDaysPerWeek) : null,
      timeSlots: timeSlots || [],
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
