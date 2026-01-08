const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital');
const Calendar = require('../models/Calendar');

// ✅ Create a new doctor
exports.createDoctor = async (req, res) => {
  try {
    const {
      firstName, lastName, email, password,
      isFullTime, contractStartDate, contractEndDate, aadharNumber, panNumber,
      timeSlots, workingDaysPerWeek, visitsPerWeek, hospitalId
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
      timeSlots: timeSlots || [],
      aadharNumber,
      panNumber,
      hospitalId: hospitalId || null
    });

    // 👇 3. Immediately add the new doctor to all relevant calendars
    try {
      console.log(`🗓️ Adding new doctor ${firstName} ${lastName} to calendars...`);
      
      // If hospitalId is provided, only update that hospital's calendar
      // Otherwise, update all hospital calendars (for multi-hospital systems)
      const hospitals = hospitalId 
        ? [await Hospital.findById(hospitalId)]
        : await Hospital.find();

      if (!hospitals || hospitals.length === 0) {
        console.warn('⚠️ No hospitals found for calendar update');
      } else {
        for (const hospital of hospitals) {
          if (!hospital) continue;
          
          await addDoctorToCalendar(hospital._id, newDoctor);
        }
      }
      
      console.log(`✅ Finished calendar update for Doctor ${newDoctor.firstName} ${newDoctor.lastName}`);
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

// Helper function to add doctor to calendar
async function addDoctorToCalendar(hospitalId, doctor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate dates for previous 15 days and next 15 days
  const datesToUpdate = [];
  for (let i = -15; i <= 15; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }

  let calendar = await Calendar.findOne({ hospitalId });
  if (!calendar) {
    // Create calendar if it doesn't exist
    calendar = new Calendar({ hospitalId, days: [] });
  }

  let needsUpdate = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    
    // Check if doctor should be available on this date
    if (!doctor.isFullTime) {
      const contractStart = doctor.contractStartDate ? new Date(doctor.contractStartDate) : null;
      const contractEnd = doctor.contractEndDate ? new Date(doctor.contractEndDate) : null;
      
      if (contractStart && targetDate < contractStart) continue;
      if (contractEnd && targetDate > contractEnd) continue;
    }

    const existingDayIndex = calendar.days.findIndex(
      d => d.date.toISOString().split('T')[0] === dateStr
    );

    if (existingDayIndex !== -1) {
      // Day exists, check if doctor is already added
      const existingDay = calendar.days[existingDayIndex];
      const isDoctorAlreadyAdded = existingDay.doctors.some(
        d => d.doctorId.toString() === doctor._id.toString()
      );

      if (!isDoctorAlreadyAdded) {
        console.log(`➕ Adding doctor ${doctor.firstName} ${doctor.lastName} to ${dateStr}`);
        needsUpdate = true;
        
        existingDay.doctors.push({
          doctorId: doctor._id,
          bookedAppointments: [],
          bookedPatients: [],
          breaks: [],
          workingHours: doctor.isFullTime ? [] : doctor.timeSlots || []
        });
      }
    } else {
      // Create new day entry with doctor
      console.log(`➕ Creating new day ${dateStr} with doctor ${doctor.firstName} ${doctor.lastName}`);
      needsUpdate = true;
      
      calendar.days.push({
        date: targetDate,
        dayName,
        doctors: [{
          doctorId: doctor._id,
          bookedAppointments: [],
          bookedPatients: [],
          breaks: [],
          workingHours: doctor.isFullTime ? [] : doctor.timeSlots || []
        }]
      });
    }
  }

  if (needsUpdate) {
    // Filter to keep only 31 days (15 before + today + 15 after)
    const todayStr = today.toISOString().split('T')[0];
    calendar.days = calendar.days.filter(day => {
      const dayDate = new Date(day.date);
      const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
      return diffDays >= -15 && diffDays <= 15;
    });

    // Sort days chronologically
    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));

    await calendar.save();
    console.log(`✅ Calendar updated for hospital ${hospitalId}`);
  } else {
    console.log(`✅ No calendar updates needed for hospital ${hospitalId}`);
  }
}

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
    
    // Also update calendar if doctor's availability changed
    if (req.body.timeSlots || req.body.isFullTime || req.body.contractStartDate || req.body.contractEndDate) {
      try {
        await updateDoctorInCalendar(doctor._id, doctor);
      } catch (calendarError) {
        console.error('Error updating doctor in calendar:', calendarError);
      }
    }
    
    res.json(doctor);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Helper function to update doctor in calendar
async function updateDoctorInCalendar(doctorId, updatedDoctor) {
  console.log(`🔄 Updating doctor ${doctorId} in calendars...`);
  
  const hospitals = await Hospital.find();
  
  for (const hospital of hospitals) {
    const calendar = await Calendar.findOne({ hospitalId: hospital._id });
    if (!calendar) continue;
    
    let updated = false;
    
    // Update each day in the calendar
    for (const day of calendar.days) {
      const doctorIndex = day.doctors.findIndex(d => d.doctorId.toString() === doctorId.toString());
      
      if (doctorIndex !== -1) {
        // Check if doctor should be available on this date
        const targetDate = new Date(day.date);
        
        if (!updatedDoctor.isFullTime) {
          const contractStart = updatedDoctor.contractStartDate ? new Date(updatedDoctor.contractStartDate) : null;
          const contractEnd = updatedDoctor.contractEndDate ? new Date(updatedDoctor.contractEndDate) : null;
          
          // If doctor is part-time and date is outside contract period, remove them
          if ((contractStart && targetDate < contractStart) || (contractEnd && targetDate > contractEnd)) {
            day.doctors.splice(doctorIndex, 1);
            updated = true;
            continue;
          }
        }
        
        // Update working hours for part-time doctors
        if (!updatedDoctor.isFullTime) {
          day.doctors[doctorIndex].workingHours = updatedDoctor.timeSlots || [];
        }
        
        updated = true;
      }
    }
    
    if (updated) {
      await calendar.save();
      console.log(`✅ Updated doctor ${doctorId} in calendar for hospital ${hospital._id}`);
    }
  }
}

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
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    
    // Remove doctor from all calendars before deleting
    try {
      await removeDoctorFromCalendar(doctor._id);
    } catch (calendarError) {
      console.error('Error removing doctor from calendar:', calendarError);
    }
    
    // Delete the doctor and associated user
    await Doctor.findByIdAndDelete(req.params.id);
    await User.findByIdAndDelete(doctor.user_id);
    
    res.json({ message: 'Doctor deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Helper function to remove doctor from calendar
async function removeDoctorFromCalendar(doctorId) {
  console.log(`🗑️ Removing doctor ${doctorId} from calendars...`);
  
  const hospitals = await Hospital.find();
  
  for (const hospital of hospitals) {
    const calendar = await Calendar.findOne({ hospitalId: hospital._id });
    if (!calendar) continue;
    
    let updated = false;
    
    // Remove doctor from all days
    for (const day of calendar.days) {
      const initialLength = day.doctors.length;
      day.doctors = day.doctors.filter(d => d.doctorId.toString() !== doctorId.toString());
      
      if (day.doctors.length !== initialLength) {
        updated = true;
      }
    }
    
    if (updated) {
      await calendar.save();
      console.log(`✅ Removed doctor ${doctorId} from calendar for hospital ${hospital._id}`);
    }
  }
}

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

      // Add doctor to calendars
      try {
        await addDoctorToCalendarForBulkImport(newDoctor);
      } catch (calendarError) {
        console.error('Error adding doctor to calendar during bulk import:', calendarError);
      }

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

// Helper function for bulk import
async function addDoctorToCalendarForBulkImport(doctor) {
  const hospitals = await Hospital.find();
  
  for (const hospital of hospitals) {
    await addDoctorToCalendar(hospital._id, doctor);
  }
}