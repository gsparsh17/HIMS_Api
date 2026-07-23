const PathologyStaff = require('../models/PathologyStaff');
const User = require('../models/User');
const LabTest = require('../models/LabTest');
const {
  normalizeFeaturePermissions,
  defaultFeaturePermissions,
  dashboardAccessFromFeatures,
  effectiveMainFeaturePermissions
} = require('../utils/mainFeatureAccess');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');
const { requireHospitalId } = require('../services/tenantScope.service');

function sendError(res, error, fallback = 'Pathology staff operation failed') {
  const status = error.statusCode || (error.code === 11000 ? 409 : 500);
  return res.status(status).json({
    success: false,
    message: status === 500 ? fallback : error.message,
    error: error.message
  });
}

function staffFilter(req, extra = {}) {
  return { hospitalId: requireHospitalId(req), ...extra };
}

function publicStaffPopulate(query) {
  return query
    .populate('user_id', 'name email role is_active modulePermissions dashboard_access staff_profile_id')
    .populate('department', 'name code head')
    .populate('accessible_test_ids', 'code name category base_price specimen_type fasting_required')
    .populate('assigned_lab_tests.lab_test_id', 'code name category base_price specimen_type fasting_required');
}

function permittedProfileUpdates(body) {
  const allowed = ['phone', 'qualification', 'specialization', 'address', 'profile_image'];
  return Object.fromEntries(
    allowed
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]])
  );
}

function applyPathologyFeaturePermissions(user, permissions, grantedBy) {
  const rows = Array.isArray(permissions)
    ? normalizeFeaturePermissions(permissions, 'pathology_staff', { grantedBy })
    : (Array.isArray(user.modulePermissions) && user.modulePermissions.length
      ? normalizeFeaturePermissions(user.modulePermissions, 'pathology_staff', { grantedBy })
      : defaultFeaturePermissions('pathology_staff', { grantedBy }));

  user.modulePermissions = rows;
  user.dashboard_access = dashboardAccessFromFeatures(rows);
}

exports.createPathologyStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const {
      user_id,
      first_name,
      last_name,
      email,
      phone,
      qualification,
      specialization,
      role,
      department,
      gender,
      date_of_birth,
      address,
      aadharNumber,
      panNumber,
      profile_image,
      accessible_test_ids = [],
      assigned_lab_tests = []
    } = req.body;

    if (!first_name || !email || !phone || !role) {
      return res.status(400).json({
        success: false,
        message: 'First name, email, phone and role are required'
      });
    }

    if (await PathologyStaff.exists({ hospitalId, email: String(email).toLowerCase() })) {
      return res.status(409).json({
        success: false,
        message: 'Staff member with this email already exists in this hospital'
      });
    }

    if (accessible_test_ids.length) {
      const validCount = await LabTest.countDocuments({
        hospitalId,
        _id: { $in: accessible_test_ids },
        is_active: true
      });

      if (validCount !== accessible_test_ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more lab tests are invalid or inactive'
        });
      }
    }

    if (assigned_lab_tests.length) {
      const ids = assigned_lab_tests.map((row) => row.lab_test_id).filter(Boolean);
      const validCount = await LabTest.countDocuments({
        hospitalId,
        _id: { $in: ids },
        is_active: true
      });

      if (validCount !== ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more assigned lab tests are invalid or inactive'
        });
      }
    }

    const staff = await PathologyStaff.create({
      hospitalId,
      user_id,
      first_name,
      last_name,
      email: String(email).toLowerCase(),
      phone,
      qualification,
      specialization,
      role,
      department,
      gender,
      date_of_birth,
      address,
      aadharNumber,
      panNumber,
      profile_image,
      accessible_test_ids,
      assigned_lab_tests,
      created_by: req.user._id
    });

    await syncHRProfileFromSource('PathologyStaff', staff, { hospital_id: hospitalId });

    const populated = await publicStaffPopulate(
      PathologyStaff.findOne({ _id: staff._id, hospitalId })
    );

    return res.status(201).json({
      success: true,
      message: 'Pathology staff created successfully',
      data: populated
    });
  } catch (error) {
    return sendError(res, error, 'Failed to create pathology staff');
  }
};

exports.getAllPathologyStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const {
      page = 1,
      limit = 20,
      role,
      status,
      department,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const filter = { hospitalId };

    if (role) filter.role = role;
    if (status) filter.status = status;
    if (department) filter.department = department;

    if (search) {
      filter.$or = ['first_name', 'last_name', 'email', 'staffId', 'qualification', 'phone']
        .map((field) => ({ [field]: { $regex: search, $options: 'i' } }));
    }

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Math.max(1, Number(limit)));

    const [staff, total, stats, roleBreakdown] = await Promise.all([
      publicStaffPopulate(
        PathologyStaff.find(filter)
          .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
          .skip((pageNumber - 1) * limitNumber)
          .limit(limitNumber)
      ),
      PathologyStaff.countDocuments(filter),
      PathologyStaff.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: null,
            totalStaff: { $sum: 1 },
            activeStaff: {
              $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] }
            },
            totalTestsAssigned: {
              $sum: { $size: { $ifNull: ['$assigned_lab_tests', []] } }
            },
            avgTestsPerStaff: {
              $avg: { $size: { $ifNull: ['$assigned_lab_tests', []] } }
            }
          }
        }
      ]),
      PathologyStaff.aggregate([
        { $match: { hospitalId } },
        { $group: { _id: '$role', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    return res.json({
      success: true,
      data: staff,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        pages: Math.ceil(total / limitNumber)
      },
      statistics: {
        ...(stats[0] || {
          totalStaff: 0,
          activeStaff: 0,
          totalTestsAssigned: 0,
          avgTestsPerStaff: 0
        }),
        roleBreakdown
      }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch pathology staff');
  }
};

exports.getPathologyStaffById = async (req, res) => {
  try {
    const staff = await publicStaffPopulate(
      PathologyStaff.findOne(staffFilter(req, { _id: req.params.id }))
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    return res.json({ success: true, data: staff });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch pathology staff');
  }
};

exports.getPathologyStaffLoginAccess = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await PathologyStaff
      .findOne({ _id: req.params.id, hospitalId })
      .populate('user_id', 'name email role modulePermissions dashboard_access is_active');

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    const user = staff.user_id || await User.findOne({
      hospital_id: hospitalId,
      email: staff.email
    }).select('name email role modulePermissions dashboard_access is_active');

    return res.json({
      success: true,
      staff: {
        _id: staff._id,
        name: `${staff.first_name || ''} ${staff.last_name || ''}`.trim(),
        email: staff.email,
        role: staff.role
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
    return sendError(res, error, 'Failed to read login access');
  }
};

exports.updatePathologyStaffLoginAccess = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await PathologyStaff.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    let user = staff.user_id
      ? await User.findOne({ _id: staff.user_id, hospital_id: hospitalId })
      : await User.findOne({ hospital_id: hospitalId, email: staff.email });

    if (!user) {
      if (!req.body.password) {
        return res.status(400).json({
          success: false,
          message: 'Password is required when enabling login for the first time'
        });
      }

      user = new User({
        name: `${staff.first_name} ${staff.last_name || ''}`.trim(),
        email: staff.email,
        password: req.body.password,
        role: 'pathology_staff',
        hospital_id: hospitalId,
        is_active: req.body.is_active !== false
      });
    }

    user.role = 'pathology_staff';
    user.hospital_id = hospitalId;

    if (req.body.is_active !== undefined) {
      user.is_active = Boolean(req.body.is_active);
    }

    if (req.body.password) {
      user.password = req.body.password;
    }

    applyPathologyFeaturePermissions(user, req.body.modulePermissions, req.user._id);

    await user.save();
    staff.user_id = user._id;
    await staff.save();

    await syncHRProfileFromSource('PathologyStaff', staff, { hospital_id: hospitalId });

    return res.json({
      success: true,
      message: 'Pathology login access updated',
      user: {
        _id: user._id,
        email: user.email,
        role: user.role,
        modulePermissions: effectiveMainFeaturePermissions(user),
        is_active: user.is_active
      }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update login access');
  }
};

exports.updatePathologyStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const blocked = new Set(['hospitalId', 'staffId', 'created_by', 'user_id']);
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([key]) => !blocked.has(key))
    );

    if (updates.email) {
      updates.email = String(updates.email).toLowerCase();
    }

    if (updates.accessible_test_ids?.length) {
      const count = await LabTest.countDocuments({
        hospitalId,
        _id: { $in: updates.accessible_test_ids },
        is_active: true
      });

      if (count !== updates.accessible_test_ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more lab tests are invalid or inactive'
        });
      }
    }

    updates.updated_by = req.user._id;

    const staff = await publicStaffPopulate(
      PathologyStaff.findOneAndUpdate(
        { _id: req.params.id, hospitalId },
        { $set: updates },
        { new: true, runValidators: true }
      )
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    await syncHRProfileFromSource('PathologyStaff', staff, { hospital_id: hospitalId });

    return res.json({
      success: true,
      message: 'Pathology staff updated successfully',
      data: staff
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update pathology staff');
  }
};

exports.deletePathologyStaff = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const staff = await PathologyStaff.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    staff.status = 'Inactive';
    staff.updated_by = req.user._id;
    await staff.save();

    if (staff.user_id) {
      await User.updateOne(
        { _id: staff.user_id, hospital_id: hospitalId },
        { $set: { is_active: false } }
      );
    }

    return res.json({
      success: true,
      message: 'Pathology staff deactivated successfully'
    });
  } catch (error) {
    return sendError(res, error, 'Failed to deactivate pathology staff');
  }
};

exports.getStaffByRole = async (req, res) => {
  try {
    const data = await publicStaffPopulate(
      PathologyStaff.find(staffFilter(req, { role: req.params.role, status: 'Active' }))
    ).sort({ first_name: 1 });

    return res.json({ success: true, data, count: data.length });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch staff by role');
  }
};

exports.assignLabTests = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const { accessible_test_ids = [], assigned_lab_tests = [] } = req.body;

    const allIds = Array.from(
      new Set([
        ...accessible_test_ids,
        ...assigned_lab_tests.map((row) => row.lab_test_id)
      ].filter(Boolean).map(String))
    );

    const count = await LabTest.countDocuments({
      hospitalId,
      _id: { $in: allIds },
      is_active: true
    });

    if (count !== allIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more lab tests are invalid or inactive'
      });
    }

    const staff = await publicStaffPopulate(
      PathologyStaff.findOneAndUpdate(
        { _id: req.params.id, hospitalId },
        {
          $set: {
            accessible_test_ids,
            assigned_lab_tests,
            updated_by: req.user._id
          }
        },
        { new: true, runValidators: true }
      )
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    return res.json({
      success: true,
      message: 'Lab-test assignments updated',
      data: staff
    });
  } catch (error) {
    return sendError(res, error, 'Failed to assign lab tests');
  }
};

exports.updatePerformanceMetrics = async (req, res) => {
  try {
    const allowed = ['tests_processed', 'avg_turnaround_time', 'accuracy_rate'];

    const updates = Object.fromEntries(
      allowed
        .filter((key) => req.body[key] !== undefined)
        .map((key) => [key, req.body[key]])
    );

    updates.updated_by = req.user._id;

    const staff = await PathologyStaff.findOneAndUpdate(
      staffFilter(req, { _id: req.params.id }),
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    return res.json({
      success: true,
      message: 'Performance metrics updated',
      data: staff
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update performance metrics');
  }
};

exports.getStaffStatistics = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const rows = await PathologyStaff.aggregate([
      { $match: { hospitalId } },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: {
                  $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] }
                },
                onLeave: {
                  $sum: { $cond: [{ $eq: ['$status', 'On Leave'] }, 1, 0] }
                },
                inactive: {
                  $sum: { $cond: [{ $eq: ['$status', 'Inactive'] }, 1, 0] }
                },
                totalTestsAssigned: {
                  $sum: { $size: { $ifNull: ['$assigned_lab_tests', []] } }
                },
                avgTestsPerStaff: {
                  $avg: { $size: { $ifNull: ['$assigned_lab_tests', []] } }
                }
              }
            }
          ],
          byRole: [
            {
              $group: {
                _id: '$role',
                count: { $sum: 1 },
                active: {
                  $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] }
                }
              }
            },
            { $sort: { count: -1 } }
          ],
          recentJoiners: [
            {
              $match: {
                joined_at: { $gte: new Date(Date.now() - 30 * 86400000) }
              }
            },
            { $count: 'count' }
          ],
          performance: [
            {
              $group: {
                _id: null,
                avgTestsProcessed: { $avg: '$tests_processed' },
                avgTurnaround: { $avg: '$avg_turnaround_time' },
                avgAccuracy: { $avg: '$accuracy_rate' }
              }
            }
          ]
        }
      }
    ]);

    const data = rows[0] || {};

    return res.json({
      success: true,
      data: {
        overall: data.overall?.[0] || {
          total: 0,
          active: 0,
          onLeave: 0,
          inactive: 0,
          totalTestsAssigned: 0,
          avgTestsPerStaff: 0
        },
        byRole: data.byRole || [],
        recentJoiners: data.recentJoiners?.[0]?.count || 0,
        performance: data.performance?.[0] || {
          avgTestsProcessed: 0,
          avgTurnaround: 0,
          avgAccuracy: 0
        }
      }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch staff statistics');
  }
};

exports.updateStaffPassword = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'A password of at least 8 characters is required'
      });
    }

    const staff = await PathologyStaff.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    let user = staff.user_id
      ? await User.findOne({ _id: staff.user_id, hospital_id: hospitalId })
      : await User.findOne({ hospital_id: hospitalId, email: staff.email });

    if (!user) {
      user = new User({
        name: `${staff.first_name} ${staff.last_name || ''}`.trim(),
        email: staff.email,
        password,
        role: 'pathology_staff',
        hospital_id: hospitalId,
        is_active: true
      });
    } else {
      user.password = password;
    }

    user.role = 'pathology_staff';
    user.hospital_id = hospitalId;

    if (!user.modulePermissions?.length) {
      applyPathologyFeaturePermissions(user, null, req.user._id);
    }

    await user.save();
    staff.user_id = user._id;
    await staff.save();

    return res.json({
      success: true,
      message: 'Password updated successfully',
      data: {
        email: staff.email,
        name: `${staff.first_name} ${staff.last_name || ''}`.trim()
      }
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update password');
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const staff = await publicStaffPopulate(
      PathologyStaff.findOne(staffFilter(req, { user_id: req.user._id }))
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff profile not found'
      });
    }

    return res.json({ success: true, data: staff });
  } catch (error) {
    return sendError(res, error, 'Failed to fetch profile');
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    const staff = await publicStaffPopulate(
      PathologyStaff.findOneAndUpdate(
        staffFilter(req, { user_id: req.user._id }),
        {
          $set: {
            ...permittedProfileUpdates(req.body),
            updated_by: req.user._id
          }
        },
        { new: true, runValidators: true }
      )
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff profile not found'
      });
    }

    await syncHRProfileFromSource('PathologyStaff', staff, {
      hospital_id: requireHospitalId(req)
    });

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      data: staff
    });
  } catch (error) {
    return sendError(res, error, 'Failed to update profile');
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Current password and a new password of at least 8 characters are required'
      });
    }

    const user = await User.findOne({
      _id: req.user._id,
      hospital_id: requireHospitalId(req)
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    user.password = newPassword;
    await user.save();

    return res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    return sendError(res, error, 'Failed to change password');
  }
};