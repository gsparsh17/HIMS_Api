const Bed = require('../models/Bed');

// ========== BED CRUD ==========

// Create new bed
exports.createBed = async (req, res) => {
  try {
    const { bedNumber, roomId, wardId, bedType, dailyCharge, features } = req.body;
    
    const bed = new Bed({
      bedNumber,
      roomId,
      wardId,
      bedType,
      dailyCharge,
      features,
      createdBy: req.user?._id
    });
    
    await bed.save();
    
    res.status(201).json({
      success: true,
      message: 'Bed created successfully',
      bed
    });
  } catch (err) {
    console.error('Error creating bed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get all beds
exports.getAllBeds = async (req, res) => {
  try {
    const { status, wardId, roomId, bedType } = req.query;
    
    const filter = { isActive: true };
    if (status) filter.status = status;
    if (wardId) filter.wardId = wardId;
    if (roomId) filter.roomId = roomId;
    if (bedType) filter.bedType = bedType;
    
    const beds = await Bed.find(filter)
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor')
      .populate('currentAdmissionId', 'admissionNumber patientId')
      .sort({ bedNumber: 1 });
    
    res.json({ success: true, beds });
  } catch (err) {
    console.error('Error fetching beds:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get available beds
exports.getAvailableBeds = async (req, res) => {
  try {
    const { wardId, bedType, date } = req.query;
    
    const filter = { status: 'Available', isActive: true };
    if (wardId) filter.wardId = wardId;
    if (bedType) filter.bedType = bedType;
    
    const beds = await Bed.find(filter)
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor')
      .sort({ dailyCharge: 1, bedNumber: 1 });
    
    res.json({ success: true, beds });
  } catch (err) {
    console.error('Error fetching available beds:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get occupied beds
exports.getOccupiedBeds = async (req, res) => {
  try {
    const beds = await Bed.find({ status: 'Occupied', isActive: true })
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor')
      .populate('currentAdmissionId', 'admissionNumber patientId primaryDoctorId')
      .populate({
        path: 'currentAdmissionId',
        populate: { path: 'patientId', select: 'first_name last_name patientId' }
      })
      .sort({ bedNumber: 1 });
    
    res.json({ success: true, beds });
  } catch (err) {
    console.error('Error fetching occupied beds:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get bed by ID
exports.getBedById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const bed = await Bed.findById(id)
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor')
      .populate('currentAdmissionId', 'admissionNumber patientId primaryDoctorId');
    
    if (!bed) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    
    res.json({ success: true, bed });
  } catch (err) {
    console.error('Error fetching bed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update bed
exports.updateBed = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const bed = await Bed.findByIdAndUpdate(id, updates, { new: true });
    if (!bed) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    
    res.json({
      success: true,
      message: 'Bed updated successfully',
      bed
    });
  } catch (err) {
    console.error('Error updating bed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update bed status
exports.updateBedStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const bed = await Bed.findById(id);
    if (!bed) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    
    bed.status = status;
    await bed.save();
    
    res.json({
      success: true,
      message: `Bed status updated to ${status}`,
      bed
    });
  } catch (err) {
    console.error('Error updating bed status:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete bed
exports.deleteBed = async (req, res) => {
  try {
    const { id } = req.params;
    
    const bed = await Bed.findById(id);
    if (!bed) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    
    if (bed.status === 'Occupied') {
      return res.status(400).json({ error: 'Cannot delete occupied bed' });
    }
    
    bed.isActive = false;
    await bed.save();
    
    res.json({
      success: true,
      message: 'Bed deactivated successfully'
    });
  } catch (err) {
    console.error('Error deleting bed:', err);
    res.status(500).json({ error: err.message });
  }
};