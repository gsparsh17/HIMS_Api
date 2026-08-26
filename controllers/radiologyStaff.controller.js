const crypto = require('crypto');
const RadiologyStaff = require('../models/RadiologyStaff');
const User = require('../models/User');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { defaultFeaturePermissions, dashboardAccessFromFeatures } = require('../utils/mainFeatureAccess');

function filter(req, extra = {}) {
  return { hospitalId: requireHospitalId(req), ...extra };
}

function populate(query) {
  return query.populate('userId', 'name email phone role is_active staff_profile_id');
}

function errorResponse(res, error) {
  const statusCode = error.statusCode || (error.code === 11000 ? 409 : 500);
  return res.status(statusCode).json({ success: false, error: error.message, message: error.message, ...(error.errors ? { errors: Object.fromEntries(Object.entries(error.errors).map(([key, value]) => [key, value.message])) } : {}) });
}

exports.getAllStaff = async (req, res) => {
  try {
    const query = filter(req);

    if (req.query.is_active !== undefined) {
      query.is_active = req.query.is_active === 'true';
    }

    if (req.query.designation) {
      query.designation = req.query.designation;
    }

    if (req.query.modality) {
      query.specializations = req.query.modality;
    }

    const staff = await populate(RadiologyStaff.find(query))
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.getStaffById = async (req, res) => {
  try {
    const staff = await populate(
      RadiologyStaff.findOne(filter(req, { _id: req.params.id }))
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Radiology staff not found'
      });
    }

    return res.json({ success: true, data: staff });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.createStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const {
      name,
      email,
      phone,
      address,
      employeeId,
      designation,
      specializations = [],
      qualification = '',
      experience_years = 0,
      license_number = '',
      joined_date,
      is_active = true,
      password
    } = req.body;

    if (!name || !email || !phone || !employeeId || !designation) {
      return res.status(400).json({
        success: false,
        error: 'Name, email, phone, employee ID and designation are required'
      });
    }

    const normalizedEmployeeId = String(employeeId).trim().toUpperCase();
    const normalizedEmail = String(email).trim().toLowerCase();

    if (await RadiologyStaff.exists({
      hospitalId,
      employeeId: normalizedEmployeeId
    })) {
      return res.status(409).json({
        success: false,
        error: 'Employee ID already exists in this hospital'
      });
    }

    if (await RadiologyStaff.exists({
      hospitalId,
      email: normalizedEmail
    })) {
      return res.status(409).json({
        success: false,
        error: 'Staff member with this email already exists in this hospital'
      });
    }

    let user = await User.findOne({
      hospital_id: hospitalId,
      email: normalizedEmail
    });

    if (user) {
      user.role = 'radiology_staff';
      user.phone = phone.trim();
      user.hospital_id = hospitalId;
      user.is_active = is_active;
      if (name) user.name = name.trim();
      if (password) user.password = password;
      await user.save();
    } else if (password) {
      const modulePermissions = defaultFeaturePermissions('radiology_staff', {
        grantedBy: req.user?._id
      });

      user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        phone: phone.trim(),
        password,
        role: 'radiology_staff',
        hospital_id: hospitalId,
        is_active,
        modulePermissions,
        dashboard_access: dashboardAccessFromFeatures(modulePermissions)
      });
    }

    if (user && await RadiologyStaff.exists({
      hospitalId,
      userId: user._id
    })) {
      return res.status(409).json({
        success: false,
        error: 'This user is already registered as radiology staff'
      });
    }

    const staff = await RadiologyStaff.create({
      hospitalId,
      userId: user?._id || undefined,
      name: name.trim(),
      email: normalizedEmail,
      phone: phone.trim(),
      address: address ? String(address).trim() : '',
      employeeId: normalizedEmployeeId,
      designation,
      specializations,
      qualification: qualification ? String(qualification).trim() : '',
      experience_years: Number(experience_years) || 0,
      license_number: license_number ? String(license_number).trim() : '',
      joined_date: joined_date || new Date(),
      is_active
    });

    await syncHRProfileFromSource('RadiologyStaff', staff, { hospital_id: hospitalId, email: normalizedEmail });

    const data = await populate(
      RadiologyStaff.findOne({ _id: staff._id, hospitalId })
    );

    return res.status(201).json({
      success: true,
      message: 'Radiology staff created successfully',
      data
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.updateStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await RadiologyStaff.findOne({ _id: req.params.id, hospitalId });

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Radiology staff not found'
      });
    }

    const { name, email, phone, address, password } = req.body;
    const staffUpdates = {};

    if (name !== undefined) staffUpdates.name = String(name).trim();
    if (email !== undefined) staffUpdates.email = String(email).trim().toLowerCase();
    if (phone !== undefined) staffUpdates.phone = String(phone).trim();
    if (address !== undefined) staffUpdates.address = String(address).trim();
    if (req.body.is_active !== undefined) staffUpdates.is_active = Boolean(req.body.is_active);

    const linkedUserId = staff.userId?._id || staff.userId;

    if (linkedUserId) {
      const userUpdates = {};
      if (name !== undefined) userUpdates.name = String(name).trim();
      if (email !== undefined) userUpdates.email = String(email).trim().toLowerCase();
      if (phone !== undefined) userUpdates.phone = String(phone).trim();
      if (req.body.is_active !== undefined) userUpdates.is_active = Boolean(req.body.is_active);

      if (Object.keys(userUpdates).length) {
        await User.updateOne(
          { _id: linkedUserId, hospital_id: hospitalId },
          { $set: userUpdates }
        );
      }

      if (password) {
        const user = await User.findOne({
          _id: linkedUserId,
          hospital_id: hospitalId
        });
        if (user) {
          user.password = password;
          await user.save();
        }
      }
    } else if (password) {
      const targetEmail = staffUpdates.email || staff.email;
      let user = await User.findOne({ hospital_id: hospitalId, email: targetEmail });
      if (user) {
        user.password = password;
        user.role = 'radiology_staff';
        await user.save();
      } else {
        const modulePermissions = defaultFeaturePermissions('radiology_staff', {
          grantedBy: req.user?._id
        });
        user = await User.create({
          name: staffUpdates.name || staff.name || 'Radiology Staff',
          email: targetEmail,
          phone: staffUpdates.phone || staff.phone || '',
          password,
          role: 'radiology_staff',
          hospital_id: hospitalId,
          is_active: staffUpdates.is_active !== undefined ? staffUpdates.is_active : staff.is_active,
          modulePermissions,
          dashboard_access: dashboardAccessFromFeatures(modulePermissions)
        });
      }
      staffUpdates.userId = user._id;
    }

    const allowed = [
      'employeeId',
      'designation',
      'specializations',
      'qualification',
      'experience_years',
      'license_number',
      'joined_date',
      'is_active',
      'modalityAssignments',
      'availabilityStatus'
    ];

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        staffUpdates[key] = key === 'employeeId' ? String(req.body[key]).toUpperCase() : req.body[key];
      }
    });

    const updated = await populate(
      RadiologyStaff.findOneAndUpdate(
        { _id: req.params.id, hospitalId },
        { $set: staffUpdates },
        { new: true, runValidators: true }
      )
    );

    await syncHRProfileFromSource('RadiologyStaff', updated, { hospital_id: hospitalId, email: updated.email });

    return res.json({
      success: true,
      message: 'Radiology staff updated successfully',
      data: updated
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.toggleStaffStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await RadiologyStaff.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Radiology staff not found'
      });
    }

    staff.is_active = !staff.is_active;
    await staff.save();

    if (staff.userId) {
      await User.updateOne(
        { _id: staff.userId, hospital_id: hospitalId },
        { $set: { is_active: staff.is_active } }
      );
    }

    return res.json({
      success: true,
      message: `Staff ${staff.is_active ? 'activated' : 'deactivated'} successfully`,
      data: { is_active: staff.is_active }
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.deleteStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await RadiologyStaff.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Radiology staff not found'
      });
    }

    staff.is_active = false;
    staff.deleted_at = new Date();
    staff.deleted_by = req.user?._id || null;
    staff.deletion_reason = String(req.body?.reason || 'Radiology staff deactivated by user').trim();
    await staff.save();

    if (staff.userId) {
      await User.updateOne(
        { _id: staff.userId, hospital_id: hospitalId },
        { $set: { is_active: false, deleted_at: staff.deleted_at, deleted_by: staff.deleted_by, deletion_reason: staff.deletion_reason } }
      );
    }

    return res.json({
      success: true,
      message: 'Radiology staff deactivated successfully'
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.getStaffByDesignation = async (req, res) => {
  try {
    const staff = await populate(
      RadiologyStaff.find(filter(req, {
        designation: req.params.designation,
        is_active: true
      }))
    ).sort({ employeeId: 1 });

    return res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

exports.getAvailableStaff = async (req, res) => {
  try {
    const query = filter(req, {
      is_active: true,
      availabilityStatus: { $ne: 'Unavailable' }
    });

    if (req.query.modality) {
      query.specializations = req.query.modality;
    }

    const staff = await populate(RadiologyStaff.find(query))
      .sort({ designation: 1, employeeId: 1 });

    return res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};