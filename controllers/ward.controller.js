const Ward = require('../models/Ward');

// Create new ward
exports.createWard = async (req, res) => {
  try {
    const { name, departmentId, floor, type, description } = req.body;
    
    // Validate required fields
    if (!name) {
      return res.status(400).json({ error: 'Ward name is required' });
    }
    
    // Generate code manually if needed
    const count = await Ward.countDocuments();
    const code = `WRD${String(count + 1).padStart(3, '0')}`;
    
    const ward = new Ward({
      name,
      code,
      departmentId: departmentId || null,
      floor: floor || '',
      type: type || 'General',
      description: description || '',
      createdBy: req.user?._id
    });
    
    await ward.save();
    
    res.status(201).json({
      success: true,
      message: 'Ward created successfully',
      ward
    });
  } catch (err) {
    console.error('Error creating ward:', err);
    // Check for duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Ward code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
};

// Get all wards
exports.getAllWards = async (req, res) => {
  try {
    const wards = await Ward.find({ isActive: true })
      .populate('departmentId', 'name')
      .sort({ name: 1 });
    
    res.json({ success: true, wards });
  } catch (err) {
    console.error('Error fetching wards:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get ward by ID
exports.getWardById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const ward = await Ward.findById(id)
      .populate('departmentId', 'name');
    
    if (!ward) {
      return res.status(404).json({ error: 'Ward not found' });
    }
    
    res.json({ success: true, ward });
  } catch (err) {
    console.error('Error fetching ward:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update ward
exports.updateWard = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, departmentId, floor, type, description } = req.body;
    
    const ward = await Ward.findById(id);
    if (!ward) {
      return res.status(404).json({ error: 'Ward not found' });
    }
    
    // Update fields
    if (name) ward.name = name;
    if (departmentId !== undefined) ward.departmentId = departmentId;
    if (floor !== undefined) ward.floor = floor;
    if (type) ward.type = type;
    if (description !== undefined) ward.description = description;
    
    await ward.save();
    
    res.json({
      success: true,
      message: 'Ward updated successfully',
      ward
    });
  } catch (err) {
    console.error('Error updating ward:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete ward (soft delete)
exports.deleteWard = async (req, res) => {
  try {
    const { id } = req.params;
    
    const ward = await Ward.findById(id);
    if (!ward) {
      return res.status(404).json({ error: 'Ward not found' });
    }
    
    ward.isActive = false;
    await ward.save();
    
    res.json({
      success: true,
      message: 'Ward deactivated successfully'
    });
  } catch (err) {
    console.error('Error deleting ward:', err);
    res.status(500).json({ error: err.message });
  }
};