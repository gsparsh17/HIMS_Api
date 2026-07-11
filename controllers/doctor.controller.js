const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital');
const Calendar = require('../models/Calendar');
const { normalizeFeaturePermissions, defaultFeaturePermissions, dashboardAccessFromFeatures, effectiveMainFeaturePermissions } = require('../utils/mainFeatureAccess');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');

// ✅ Create a new doctor
exports.createDoctor = async (req, res) => {
  try {
    const {
      firstName, lastName, email,
      isFullTime, contractStartDate, contractEndDate, aadharNumber, panNumber,
      timeSlots, workingDaysPerWeek, visitsPerWeek, hospitalId,
      revenuePercentage // NEW FIELD
    } = req.body;

    // ✅ Create Doctor
    const newDoctor = await Doctor.create({
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
      revenuePercentage: revenuePercentage ? Number(revenuePercentage) : undefined, // NEW FIELD
      contractStartDate: contractStartDate ? new Date(contractStartDate) : null,
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      visitsPerWeek: req.body.visitsPerWeek ? Number(req.body.visitsPerWeek) : null,
      workingDaysPerWeek: req.body.workingDaysPerWeek ? req.body.workingDaysPerWeek : null,
      timeSlots: timeSlots || [],
      aadharNumber,
      panNumber,
      hospitalId: hospitalId || null
    });


    // Explicitly await HR synchronization so the employee record is available
    // immediately to payroll/attendance APIs without waiting for background hooks.
    await syncHRProfileFromSource('Doctor', newDoctor, {
      hospital_id: req.user?.hospital_id || req.body?.hospitalId || undefined
    });

    // Add doctor to calendars
    try {
      console.log(`🗓️ Adding new doctor ${firstName} ${lastName} to calendars...`);
      
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
    }

    res.status(201).json({
      message: 'Doctor created successfully (Please set login credentials in Staff Login)',
      doctor: newDoctor
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

  const datesToUpdate = [];
  for (let i = -15; i <= 15; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }

  let calendar = await Calendar.findOne({ hospitalId });
  if (!calendar) {
    calendar = new Calendar({ hospitalId, days: [] });
  }

  let needsUpdate = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
    
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
    const todayStr = today.toISOString().split('T')[0];
    calendar.days = calendar.days.filter(day => {
      const dayDate = new Date(day.date);
      const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
      return diffDays >= -15 && diffDays <= 15;
    });

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



function applyDoctorFeaturePermissions(user, permissions, grantedBy) {
  const rows = Array.isArray(permissions)
    ? normalizeFeaturePermissions(permissions, 'doctor', { grantedBy })
    : (Array.isArray(user.modulePermissions) && user.modulePermissions.length
      ? normalizeFeaturePermissions(user.modulePermissions, 'doctor', { grantedBy })
      : defaultFeaturePermissions('doctor', { grantedBy }));
  user.modulePermissions = rows;
  user.dashboard_access = dashboardAccessFromFeatures(rows);
}

exports.getDoctorLoginAccess = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id).populate('user_id', 'name email role modulePermissions dashboard_access is_active');
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    const user = doctor.user_id || await User.findOne({ email: doctor.email }).select('name email role modulePermissions dashboard_access is_active');
    return res.json({
      success: true,
      doctor: { _id: doctor._id, name: `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim(), email: doctor.email },
      user: user ? { _id: user._id, email: user.email, role: user.role, modulePermissions: effectiveMainFeaturePermissions(user), is_active: user.is_active } : null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.updateDoctorLoginAccess = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    if (!doctor.email) return res.status(400).json({ error: 'Doctor email is required to create login credentials' });

    let user = doctor.user_id ? await User.findById(doctor.user_id) : null;
    if (!user) user = await User.findOne({ email: doctor.email });
    if (!user) {
      if (!req.body?.password) return res.status(400).json({ error: 'Password is required when creating a new login' });
      user = new User({
        name: `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim(),
        email: doctor.email,
        phone: doctor.phone,
        role: 'doctor',
        password: req.body.password,
        hospital_id: req.user?.hospital_id || undefined
      });
    } else {
      user.name = `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim();
      user.email = doctor.email;
      user.phone = doctor.phone;
      user.role = 'doctor';
      if (req.body?.password) user.password = req.body.password;
      if (req.user?.hospital_id && !user.hospital_id) user.hospital_id = req.user.hospital_id;
    }

    applyDoctorFeaturePermissions(user, req.body?.modulePermissions || req.body?.mainFeaturePermissions, req.user?._id);
    await user.save();
    if (!doctor.user_id || String(doctor.user_id) !== String(user._id)) {
      doctor.user_id = user._id;
      await doctor.save();
    }

    return res.json({
      success: true,
      message: 'Login credentials and main feature access saved successfully',
      user: { _id: user._id, email: user.email, role: user.role, modulePermissions: effectiveMainFeaturePermissions(user) }
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

// Update a doctor by ID
exports.updateDoctor = async (req, res) => {
  try {
    // Handle revenuePercentage update
    if (req.body.revenuePercentage !== undefined) {
      req.body.revenuePercentage = Number(req.body.revenuePercentage);
      
      // Validate percentage for part-time doctors
      if (req.body.revenuePercentage < 0 || req.body.revenuePercentage > 100) {
        return res.status(400).json({ error: 'Revenue percentage must be between 0 and 100' });
      }
    }

    const doctor = await Doctor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });
    
    // Check if password update is requested
    if (req.body.password) {
      const { password } = req.body;
      let user = await User.findById(doctor.user_id);
      
      if (user) {
        user.password = password;
        user.name = `${doctor.firstName} ${doctor.lastName}`;
        user.email = doctor.email; 
        await user.save();
        console.log(`✅ Password updated for user associated with Doctor ${doctor._id}`);
      } else {
        user = await User.findOne({ email: doctor.email });
        if (user) {
           user.password = password;
           user.role = 'doctor';
           await user.save();
        } else {
           user = await User.create({
            name: `${doctor.firstName} ${doctor.lastName}`,
            email: doctor.email,
            password: password,
            role: 'doctor'
          });
          doctor.user_id = user._id;
          await doctor.save();
        }
        console.log(`✅ Created/Linked User for Doctor ${doctor._id}`);
      }
    }

    // Update calendar if doctor's availability changed
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
    
    for (const day of calendar.days) {
      const doctorIndex = day.doctors.findIndex(d => d.doctorId.toString() === doctorId.toString());
      
      if (doctorIndex !== -1) {
        const targetDate = new Date(day.date);
        
        if (!updatedDoctor.isFullTime) {
          const contractStart = updatedDoctor.contractStartDate ? new Date(updatedDoctor.contractStartDate) : null;
          const contractEnd = updatedDoctor.contractEndDate ? new Date(updatedDoctor.contractEndDate) : null;
          
          if ((contractStart && targetDate < contractStart) || (contractEnd && targetDate > contractEnd)) {
            day.doctors.splice(doctorIndex, 1);
            updated = true;
            continue;
          }
        }
        
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

    const doctors = await Doctor.find({ department: departmentId })
      .populate('department')
      .populate('user_id', 'name email role');

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
      // Check if user already exists
      const userExists = await User.findOne({ email: doctor.email });
      if (userExists) throw new Error('User with this email already exists.');

      // Resolve department name
      let departmentId = null;
      if (doctor.department) {
        const dept = await Department.findOne({ name: new RegExp(`^${doctor.department}$`, 'i') });
        if (!dept) throw new Error(`Department "${doctor.department}" not found.`);
        departmentId = dept._id;
      }

      // Create User
      const newUser = await User.create({
        name: `${doctor.firstName} ${doctor.lastName}`,
        email: doctor.email,
        password: doctor.password,
        role: 'doctor'
      });

      // Create Doctor - INCLUDING revenuePercentage
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
        revenuePercentage: doctor.revenuePercentage ? Number(doctor.revenuePercentage) : undefined, // NEW FIELD
        isFullTime: doctor.isFullTime === 'true' || doctor.isFullTime === true,
        contractStartDate: doctor.contractStartDate ? new Date(doctor.contractStartDate) : null,
        contractEndDate: doctor.contractEndDate ? new Date(doctor.contractEndDate) : null,
        visitsPerWeek: doctor.visitsPerWeek ? Number(doctor.visitsPerWeek) : null,
        workingDaysPerWeek: doctor.workingDaysPerWeek ? Number(doctor.workingDaysPerWeek) : null,
        aadharNumber: doctor.aadharNumber || null,
        panNumber: doctor.panNumber || null,
        notes: doctor.notes || ''
      });

  
    // Explicitly await HR synchronization so the employee record is available
    // immediately to payroll/attendance APIs without waiting for background hooks.
    await syncHRProfileFromSource('Doctor', newDoctor, {
      hospital_id: req.user?.hospital_id || req.body?.hospitalId || undefined
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