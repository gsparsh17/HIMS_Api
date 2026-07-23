const Doctor = require('../models/Doctor');
const User = require('../models/User');
const Department = require('../models/Department');
const Hospital = require('../models/Hospital');
const Calendar = require('../models/Calendar');
const {
  normalizeFeaturePermissions,
  defaultFeaturePermissions,
  dashboardAccessFromFeatures,
  effectiveMainFeaturePermissions
} = require('../utils/mainFeatureAccess');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');
const { requireHospitalId: requireDoctorHospitalId } = require('../services/tenantScope.service');

// ✅ Create a new doctor
exports.createDoctor = async (req, res) => {
  try {
    const hospitalId = requireDoctorHospitalId(req);

    if (req.body.department) {
      const exists = await Department.exists({
        _id: req.body.department,
        hospitalId
      });

      if (!exists) {
        return res.status(400).json({
          error: 'Department not found in this hospital'
        });
      }
    }

    const data = {
      ...req.body,
      hospitalId,
      dateOfBirth: req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
      startDate: req.body.startDate ? new Date(req.body.startDate) : undefined,
      contractStartDate: req.body.contractStartDate ? new Date(req.body.contractStartDate) : null,
      contractEndDate: req.body.contractEndDate ? new Date(req.body.contractEndDate) : null
    };

    const doctor = await Doctor.create(data);
    await syncHRProfileFromSource('Doctor', doctor, { hospital_id: hospitalId });

    try {
      await addDoctorToCalendar(hospitalId, doctor);
    } catch (error) {
      console.error('Calendar sync failed:', error.message);
    }

    return res.status(201).json({
      message: 'Doctor created successfully (Please set login credentials in Staff Login)',
      doctor
    });
  } catch (error) {
    const statusCode = error.code === 11000 ? 409 : 400;
    return res.status(statusCode).json({ error: error.message });
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
    const hospitalId = requireDoctorHospitalId(req);

    const doctors = await Doctor
      .find({ hospitalId })
      .populate('department')
      .populate('user_id', 'name email role')
      .sort({ firstName: 1 });

    return res.json(doctors);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Get a doctor by ID
exports.getDoctorById = async (req, res) => {
  try {
    const hospitalId = requireDoctorHospitalId(req);

    const doctor = await Doctor
      .findOne({ _id: req.params.id, hospitalId })
      .populate('department')
      .populate('user_id', 'name email role');

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    return res.json(doctor);
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
    const hospitalId = requireDoctorHospitalId(req);

    const doctor = await Doctor
      .findOne({ _id: req.params.id, hospitalId })
      .populate('user_id', 'name email role modulePermissions dashboard_access is_active');

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    const user = doctor.user_id || await User.findOne({
      email: doctor.email,
      hospital_id: hospitalId
    });

    return res.json({
      success: true,
      doctor: {
        _id: doctor._id,
        name: `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim(),
        email: doctor.email
      },
      user: user ? {
        _id: user._id,
        email: user.email,
        role: user.role,
        modulePermissions: effectiveMainFeaturePermissions(user),
        is_active: user.is_active
      } : null
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.updateDoctorLoginAccess = async (req, res) => {
  try {
    const hospitalId = requireDoctorHospitalId(req);

    const doctor = await Doctor.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    let user = doctor.user_id
      ? await User.findOne({ _id: doctor.user_id, hospital_id: hospitalId })
      : await User.findOne({ email: doctor.email, hospital_id: hospitalId });

    if (!user) {
      if (!req.body.password) {
        return res.status(400).json({
          error: 'Password is required when creating a new login'
        });
      }

      user = new User({
        name: `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim(),
        email: doctor.email,
        phone: doctor.phone,
        role: 'doctor',
        password: req.body.password,
        hospital_id: hospitalId
      });
    } else {
      user.name = `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim();
      user.phone = doctor.phone;
      user.role = 'doctor';

      if (req.body.password) {
        user.password = req.body.password;
      }
    }

    applyDoctorFeaturePermissions(
      user,
      req.body.modulePermissions || req.body.mainFeaturePermissions,
      req.user?._id
    );

    user.is_active = req.body.is_active !== undefined
      ? Boolean(req.body.is_active)
      : user.is_active;

    await user.save();
    doctor.user_id = user._id;
    await doctor.save();

    await syncHRProfileFromSource('Doctor', doctor, { hospital_id: hospitalId });

    return res.json({
      success: true,
      user: {
        _id: user._id,
        email: user.email,
        role: user.role,
        modulePermissions: effectiveMainFeaturePermissions(user),
        is_active: user.is_active
      }
    });
  } catch (error) {
    const statusCode = error.code === 11000 ? 409 : 400;
    return res.status(statusCode).json({ error: error.message });
  }
};

// Update a doctor by ID
exports.updateDoctor = async (req, res) => {
  try {
    const hospitalId = requireDoctorHospitalId(req);

    if (req.body.department) {
      const exists = await Department.exists({
        _id: req.body.department,
        hospitalId
      });

      if (!exists) {
        return res.status(400).json({
          error: 'Department not found in this hospital'
        });
      }
    }

    delete req.body.hospitalId;

    const doctor = await Doctor.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      req.body,
      { new: true, runValidators: true }
    );

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    await syncHRProfileFromSource('Doctor', doctor, { hospital_id: hospitalId });

    return res.json(doctor);
  } catch (error) {
    const statusCode = error.code === 11000 ? 409 : 400;
    return res.status(statusCode).json({ error: error.message });
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
      const doctorIndex = day.doctors.findIndex(
        d => d.doctorId.toString() === doctorId.toString()
      );

      if (doctorIndex !== -1) {
        const targetDate = new Date(day.date);

        if (!updatedDoctor.isFullTime) {
          const contractStart = updatedDoctor.contractStartDate
            ? new Date(updatedDoctor.contractStartDate)
            : null;
          const contractEnd = updatedDoctor.contractEndDate
            ? new Date(updatedDoctor.contractEndDate)
            : null;

          if ((contractStart && targetDate < contractStart) ||
              (contractEnd && targetDate > contractEnd)) {
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
    const hospitalId = requireDoctorHospitalId(req);

    const doctors = await Doctor
      .find({
        hospitalId,
        department: req.params.departmentId
      })
      .populate('department')
      .sort({ firstName: 1 });

    return res.json(doctors);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Delete a doctor by ID
exports.deleteDoctor = async (req, res) => {
  try {
    const hospitalId = requireDoctorHospitalId(req);

    const doctor = await Doctor.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    if (doctor.user_id) {
      await User.updateOne(
        { _id: doctor.user_id, hospital_id: hospitalId },
        { is_active: false }
      );
    }

    await Doctor.deleteOne({ _id: doctor._id, hospitalId });

    return res.json({ message: 'Doctor deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
      day.doctors = day.doctors.filter(
        d => d.doctorId.toString() !== doctorId.toString()
      );

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
  try {
    const hospitalId = requireDoctorHospitalId(req);

    const rows = Array.isArray(req.body) ? req.body : req.body.doctors;

    if (!Array.isArray(rows)) {
      return res.status(400).json({
        error: 'Expected an array of doctors'
      });
    }

    const created = [];
    const failed = [];

    for (const row of rows) {
      try {
        if (row.department) {
          const exists = await Department.exists({
            _id: row.department,
            hospitalId
          });

          if (!exists) {
            throw new Error('Department not found in this hospital');
          }
        }

        const doctor = await Doctor.create({ ...row, hospitalId });
        await syncHRProfileFromSource('Doctor', doctor, { hospital_id: hospitalId });
        created.push(doctor);
      } catch (error) {
        failed.push({
          email: row.email,
          error: error.message
        });
      }
    }

    return res.status(201).json({
      successfulCount: created.length,
      failedCount: failed.length,
      doctors: created,
      failed
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
};

// Helper function for bulk import
async function addDoctorToCalendarForBulkImport(doctor) {
  const hospitals = await Hospital.find();

  for (const hospital of hospitals) {
    await addDoctorToCalendar(hospital._id, doctor);
  }
}