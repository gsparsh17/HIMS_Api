const RadiologyStaff = require('../models/RadiologyStaff');
const User = require('../models/User');

// Get all radiology staff
exports.getAllStaff = async (req, res) => {
  try {
    const { is_active, designation } = req.query;
    const filter = {};
    
    if (is_active !== undefined) filter.is_active = is_active === 'true';
    if (designation) filter.designation = designation;
    
    const staff = await RadiologyStaff.find(filter)
      .populate('userId', 'name email phone address')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    console.error('Error fetching radiology staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get single staff member by ID
exports.getStaffById = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await RadiologyStaff.findById(id)
      .populate('userId', 'name email phone address');
    
    if (!staff) {
      return res.status(404).json({ error: 'Radiology staff not found' });
    }
    
    res.json({ success: true, data: staff });
  } catch (error) {
    console.error('Error fetching radiology staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Create new radiology staff
exports.createStaff = async (req, res) => {
  try {
    const {
      name, email, phone, address,
      employeeId, designation, specializations,
      qualification, experience_years, license_number,
      joined_date, is_active
    } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !employeeId || !designation) {
      return res.status(400).json({ 
        error: 'Name, email, phone, employee ID, and designation are required' 
      });
    }

    // Check if user already exists
    let user = await User.findOne({ email });
    
    if (!user) {
      // Create new user
      user = new User({
        name,
        email,
        phone,
        address: address || '',
        role: 'staff',
        isActive: true
      });
      await user.save();
    }

    // Check if staff already exists with this employeeId
    const existingStaff = await RadiologyStaff.findOne({ employeeId });
    if (existingStaff) {
      return res.status(400).json({ error: 'Staff with this employee ID already exists' });
    }

    // Check if user is already linked to staff
    const existingUserStaff = await RadiologyStaff.findOne({ userId: user._id });
    if (existingUserStaff) {
      return res.status(400).json({ error: 'This user is already registered as staff' });
    }

    // Create radiology staff
    const staff = new RadiologyStaff({
      userId: user._id,
      employeeId: employeeId.toUpperCase(),
      designation,
      specializations: specializations || [],
      qualification: qualification || '',
      experience_years: experience_years || 0,
      license_number: license_number || '',
      is_active: is_active !== undefined ? is_active : true,
      joined_date: joined_date || new Date()
    });

    await staff.save();

    const populatedStaff = await RadiologyStaff.findById(staff._id)
      .populate('userId', 'name email phone address');

    res.status(201).json({
      success: true,
      message: 'Radiology staff created successfully',
      data: populatedStaff
    });
  } catch (error) {
    console.error('Error creating radiology staff:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Employee ID already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

// Update radiology staff
exports.updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, email, phone, address,
      employeeId, designation, specializations,
      qualification, experience_years, license_number,
      joined_date, is_active
    } = req.body;

    const staff = await RadiologyStaff.findById(id).populate('userId');
    if (!staff) {
      return res.status(404).json({ error: 'Radiology staff not found' });
    }

    // Update user information if provided
    if (name || email || phone || address) {
      const userUpdates = {};
      if (name) userUpdates.name = name;
      if (email) userUpdates.email = email;
      if (phone) userUpdates.phone = phone;
      if (address !== undefined) userUpdates.address = address;
      
      await User.findByIdAndUpdate(staff.userId._id, userUpdates);
    }

    // Update staff information
    const staffUpdates = {};
    if (employeeId) staffUpdates.employeeId = employeeId.toUpperCase();
    if (designation) staffUpdates.designation = designation;
    if (specializations !== undefined) staffUpdates.specializations = specializations;
    if (qualification !== undefined) staffUpdates.qualification = qualification;
    if (experience_years !== undefined) staffUpdates.experience_years = experience_years;
    if (license_number !== undefined) staffUpdates.license_number = license_number;
    if (joined_date) staffUpdates.joined_date = joined_date;
    if (is_active !== undefined) staffUpdates.is_active = is_active;

    const updatedStaff = await RadiologyStaff.findByIdAndUpdate(
      id,
      staffUpdates,
      { new: true, runValidators: true }
    ).populate('userId', 'name email phone address');

    res.json({
      success: true,
      message: 'Radiology staff updated successfully',
      data: updatedStaff
    });
  } catch (error) {
    console.error('Error updating radiology staff:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Employee ID already exists' });
    }
    res.status(500).json({ error: error.message });
  }
};

// Toggle staff status (activate/deactivate)
exports.toggleStaffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await RadiologyStaff.findById(id);
    
    if (!staff) {
      return res.status(404).json({ error: 'Radiology staff not found' });
    }

    staff.is_active = !staff.is_active;
    await staff.save();

    res.json({
      success: true,
      message: `Staff ${staff.is_active ? 'activated' : 'deactivated'} successfully`,
      data: { is_active: staff.is_active }
    });
  } catch (error) {
    console.error('Error toggling staff status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete radiology staff
exports.deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await RadiologyStaff.findById(id);
    
    if (!staff) {
      return res.status(404).json({ error: 'Radiology staff not found' });
    }

    // Optionally delete the associated user or just mark as inactive
    // await User.findByIdAndDelete(staff.userId);
    
    await RadiologyStaff.findByIdAndDelete(id);
    
    res.json({
      success: true,
      message: 'Radiology staff deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting radiology staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get staff by designation
exports.getStaffByDesignation = async (req, res) => {
  try {
    const { designation } = req.params;
    const staff = await RadiologyStaff.find({ 
      designation, 
      is_active: true 
    }).populate('userId', 'name email phone');
    
    res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    console.error('Error fetching staff by designation:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get available staff (active)
exports.getAvailableStaff = async (req, res) => {
  try {
    const staff = await RadiologyStaff.find({ is_active: true })
      .populate('userId', 'name email phone')
      .sort({ designation: 1 });
    
    res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    console.error('Error fetching available staff:', error);
    res.status(500).json({ error: error.message });
  }
};