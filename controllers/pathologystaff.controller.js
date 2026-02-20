// controllers/pathologyStaff.controller.js
const PathologyStaff = require('../models/PathologyStaff');
const User = require('../models/User');
const LabTest = require('../models/LabTest');

exports.createPathologyStaff = async (req, res) => {
  try {
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
      accessible_test_ids,
      assigned_lab_tests
    } = req.body;

    // Check if staff already exists with this email
    const existingStaff = await PathologyStaff.findOne({ email });
    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'Staff member with this email already exists'
      });
    }

    // Validate lab tests if provided
    if (accessible_test_ids && accessible_test_ids.length > 0) {
      const validTests = await LabTest.find({
        _id: { $in: accessible_test_ids },
        is_active: true
      });

      if (validTests.length !== accessible_test_ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more lab tests are invalid or inactive'
        });
      }
    }

    // Create staff record
    const staff = new PathologyStaff({
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
      accessible_test_ids: accessible_test_ids || [],
      assigned_lab_tests: assigned_lab_tests || [],
      created_by: req.user?._id
    });

    await staff.save();

    // Populate references
    await staff.populate([
      { path: 'user_id', select: 'name email role' },
      { path: 'department', select: 'name code' },
      { path: 'accessible_test_ids', select: 'code name category base_price' },
      { path: 'assigned_lab_tests.lab_test_id', select: 'code name category base_price' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Pathology staff created successfully',
      data: staff
    });
  } catch (error) {
    console.error('Error creating pathology staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create pathology staff',
      error: error.message
    });
  }
};

exports.getAllPathologyStaff = async (req, res) => {
  try {
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

    const filter = {};

    // Apply filters
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (department) filter.department = department;

    // Search functionality
    if (search) {
      filter.$or = [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { staffId: { $regex: search, $options: 'i' } },
        { qualification: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const staff = await PathologyStaff.find(filter)
      .populate('user_id', 'name email role')
      .populate('department', 'name code')
      .populate('accessible_test_ids', 'code name category base_price')
      .populate('assigned_lab_tests.lab_test_id', 'code name category base_price')
      .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await PathologyStaff.countDocuments(filter);

    // Get statistics
    const stats = await PathologyStaff.aggregate([
      {
        $group: {
          _id: null,
          totalStaff: { $sum: 1 },
          activeStaff: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
          totalTestsAssigned: { $sum: { $size: '$assigned_lab_tests' } },
          avgTestsPerStaff: { $avg: { $size: '$assigned_lab_tests' } }
        }
      }
    ]);

    // Role-wise breakdown
    const roleBreakdown = await PathologyStaff.aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      data: staff,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
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
    console.error('Error fetching pathology staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pathology staff',
      error: error.message
    });
  }
};

exports.getPathologyStaffById = async (req, res) => {
  try {
    const { id } = req.params;

    const staff = await PathologyStaff.findById(id)
      .populate('user_id', 'name email role')
      .populate('department', 'name code head')
      .populate('accessible_test_ids', 'code name category base_price specimen_type fasting_required')
      .populate('assigned_lab_tests.lab_test_id', 'code name category base_price specimen_type fasting_required');

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    res.json({
      success: true,
      data: staff
    });
  } catch (error) {
    console.error('Error fetching pathology staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pathology staff',
      error: error.message
    });
  }
};

exports.updatePathologyStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Remove fields that shouldn't be updated directly
    delete updates._id;
    delete updates.staffId;
    delete updates.user_id;
    delete updates.created_by;

    // Validate lab tests if being updated
    if (updates.accessible_test_ids) {
      const validTests = await LabTest.find({
        _id: { $in: updates.accessible_test_ids },
        is_active: true
      });

      if (validTests.length !== updates.accessible_test_ids.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more lab tests are invalid or inactive'
        });
      }
    }

    // If assigned_lab_tests is being updated, format it properly
    if (updates.assigned_lab_tests) {
      const testIds = updates.assigned_lab_tests.map(t => t.lab_test_id);
      const validTests = await LabTest.find({
        _id: { $in: testIds },
        is_active: true
      });

      if (validTests.length !== testIds.length) {
        return res.status(400).json({
          success: false,
          message: 'One or more assigned lab tests are invalid or inactive'
        });
      }

      // Add metadata to each assignment
      updates.assigned_lab_tests = updates.assigned_lab_tests.map(test => ({
        ...test,
        assigned_at: test.assigned_at || new Date()
      }));
    }

    updates.updated_by = req.user?._id;

    const staff = await PathologyStaff.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    )
      .populate('user_id', 'name email role')
      .populate('department', 'name code')
      .populate('accessible_test_ids', 'code name category base_price')
      .populate('assigned_lab_tests.lab_test_id', 'code name category base_price');

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    res.json({
      success: true,
      message: 'Pathology staff updated successfully',
      data: staff
    });
  } catch (error) {
    console.error('Error updating pathology staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update pathology staff',
      error: error.message
    });
  }
};

exports.deletePathologyStaff = async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete - set status to Inactive instead of actually deleting
    const staff = await PathologyStaff.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'Inactive',
          updated_by: req.user?._id
        }
      },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    // Also deactivate the associated user account
    if (staff.user_id) {
      await User.findByIdAndUpdate(staff.user_id, {
        $set: { is_active: false }
      });
    }

    res.json({
      success: true,
      message: 'Pathology staff deactivated successfully',
      data: staff
    });
  } catch (error) {
    console.error('Error deleting pathology staff:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete pathology staff',
      error: error.message
    });
  }
};

exports.getStaffByRole = async (req, res) => {
  try {
    const { role } = req.params;
    const { status = 'Active' } = req.query;

    const staff = await PathologyStaff.find({
      role,
      status
    })
      .populate('user_id', 'name email')
      .populate('department', 'name')
      .select('first_name last_name email phone staffId qualification specialization');

    res.json({
      success: true,
      count: staff.length,
      data: staff
    });
  } catch (error) {
    console.error('Error fetching staff by role:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch staff by role',
      error: error.message
    });
  }
};

exports.assignLabTests = async (req, res) => {
  try {
    const { id } = req.params;
    const { test_ids } = req.body;

    if (!test_ids || !Array.isArray(test_ids)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of test IDs'
      });
    }

    // Get valid lab tests
    const validTests = await LabTest.find({
      _id: { $in: test_ids },
      is_active: true
    });

    if (validTests.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid lab tests found'
      });
    }

    // Create assignment objects
    const assignments = validTests.map(test => ({
      lab_test_id: test._id,
      lab_test_code: test.code,
      lab_test_name: test.name,
      category: test.category,
      can_perform: true,
      assigned_at: new Date()
    }));

    const staff = await PathologyStaff.findByIdAndUpdate(
      id,
      {
        $set: {
          assigned_lab_tests: assignments,
          accessible_test_ids: validTests.map(t => t._id)
        },
        updated_by: req.user?._id
      },
      { new: true }
    )
      .populate('accessible_test_ids', 'code name category base_price')
      .populate('assigned_lab_tests.lab_test_id', 'code name category base_price');

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    res.json({
      success: true,
      message: `${validTests.length} lab tests assigned successfully`,
      data: staff
    });
  } catch (error) {
    console.error('Error assigning lab tests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign lab tests',
      error: error.message
    });
  }
};

exports.updatePerformanceMetrics = async (req, res) => {
  try {
    const { id } = req.params;
    const { tests_processed, avg_turnaround_time, accuracy_rate } = req.body;

    const staff = await PathologyStaff.findByIdAndUpdate(
      id,
      {
        $set: {
          tests_processed,
          avg_turnaround_time,
          accuracy_rate
        }
      },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    res.json({
      success: true,
      message: 'Performance metrics updated successfully',
      data: staff
    });
  } catch (error) {
    console.error('Error updating performance metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update performance metrics',
      error: error.message
    });
  }
};

exports.getStaffStatistics = async (req, res) => {
  try {
    const stats = await PathologyStaff.aggregate([
      {
        $facet: {
          // Overall stats
          overall: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } },
                onLeave: { $sum: { $cond: [{ $eq: ['$status', 'On Leave'] }, 1, 0] } },
                inactive: { $sum: { $cond: [{ $eq: ['$status', 'Inactive'] }, 1, 0] } },
                totalTestsAssigned: { $sum: { $size: '$assigned_lab_tests' } },
                avgTestsPerStaff: { $avg: { $size: '$assigned_lab_tests' } }
              }
            }
          ],
          // Role breakdown
          byRole: [
            {
              $group: {
                _id: '$role',
                count: { $sum: 1 },
                active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } }
              }
            },
            { $sort: { count: -1 } }
          ],
          // Recent joiners (last 30 days)
          recentJoiners: [
            {
              $match: {
                joined_at: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
              }
            },
            { $count: 'count' }
          ],
          // Performance summary
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

    res.json({
      success: true,
      data: {
        overall: stats[0].overall[0] || {
          total: 0,
          active: 0,
          onLeave: 0,
          inactive: 0,
          totalTestsAssigned: 0,
          avgTestsPerStaff: 0
        },
        byRole: stats[0].byRole,
        recentJoiners: stats[0].recentJoiners[0]?.count || 0,
        performance: stats[0].performance[0] || {
          avgTestsProcessed: 0,
          avgTurnaround: 0,
          avgAccuracy: 0
        }
      }
    });
  } catch (error) {
    console.error('Error fetching staff statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch staff statistics',
      error: error.message
    });
  }
};

// Add to controllers/pathologyStaff.controller.js
exports.updateStaffPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { password, email } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required'
      });
    }

    // Find the staff member
    const staff = await PathologyStaff.findById(id);
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff not found'
      });
    }

    // Check if user exists
    let user = await User.findOne({ email: staff.email });

    if (user) {
      // Update existing user's password
      user.password = password;
      await user.save();
    } else {
      // Create new user for this staff member
      user = await User.create({
        name: `${staff.first_name} ${staff.last_name || ''}`.trim(),
        email: staff.email,
        password: password,
        role: 'pathology_staff'
      });

      // Update staff with user_id
      staff.user_id = user._id;
      await staff.save();
    }

    res.json({
      success: true,
      message: 'Password updated successfully',
      data: {
        email: staff.email,
        name: `${staff.first_name} ${staff.last_name || ''}`.trim()
      }
    });
  } catch (error) {
    console.error('Error updating staff password:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update password',
      error: error.message
    });
  }
};

// @desc    Get current pathology staff profile
// @route   GET /api/pathology-staff/profile/me
// @access  Private (Pathology Staff only)
exports.getMyProfile = async (req, res) => {
  try {
    const staff = await PathologyStaff.findOne({ user_id: req.user._id })
      .populate('user_id', 'name email')
      .populate('department', 'name code')
      .populate('accessible_test_ids', 'code name category')
      .populate('assigned_lab_tests.lab_test_id', 'code name category base_price');

    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff profile not found'
      });
    }

    res.json({
      success: true,
      data: staff
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile',
      error: error.message
    });
  }
};

// @desc    Update my profile
// @route   PUT /api/pathology-staff/profile/me
// @access  Private (Pathology Staff only)
exports.updateMyProfile = async (req, res) => {
  try {
    const staff = await PathologyStaff.findOne({ user_id: req.user._id });
    
    if (!staff) {
      return res.status(404).json({
        success: false,
        message: 'Pathology staff profile not found'
      });
    }

    // Fields that staff can update
    const allowedUpdates = ['phone', 'qualification', 'specialization', 'profile_image'];
    const updates = {};

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const updatedStaff = await PathologyStaff.findByIdAndUpdate(
      staff._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('user_id', 'name email');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: updatedStaff
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
};