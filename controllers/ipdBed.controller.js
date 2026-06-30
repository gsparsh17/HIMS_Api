// controllers/ipdBed.controller.js
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const Ward = require('../models/Ward');
const IPDAdmission = require('../models/IPDAdmission');

// ========== BED CRUD ==========

// Create new bed
exports.createBed = async (req, res) => {
  try {
    const { bedNumber, roomId, wardId, bedType, dailyCharge, features } = req.body;
    
    // Validate required fields
    if (!bedNumber) {
      return res.status(400).json({ error: 'Bed number is required' });
    }
    if (!roomId) {
      return res.status(400).json({ error: 'Room ID is required' });
    }
    if (!bedType) {
      return res.status(400).json({ error: 'Bed type is required' });
    }
    
    // Verify room exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Generate bed code manually
    const count = await Bed.countDocuments();
    const bedCode = `BED${String(count + 1).padStart(4, '0')}`;
    
    const bed = new Bed({
      bedNumber,
      bedCode,
      roomId,
      wardId: wardId || null,
      bedType,
      dailyCharge: dailyCharge || 0,
      features: features || [],
      status: 'Available',
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
    // Check for duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Bed code already exists' });
    }
    res.status(500).json({ error: err.message });
  }
};

// Get all beds with full admission details
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
      .populate({
        path: 'currentAdmissionId',
        select: 'admissionNumber patientId primaryDoctorId admissionDate status',
        populate: [
          { path: 'patientId', select: 'first_name last_name patientId uhid phone gender' },
          { path: 'primaryDoctorId', select: 'firstName lastName specialization' }
        ]
      })
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
    const { wardId, roomId, bedType } = req.query;
    
    const filter = { status: 'Available', isActive: true };
    if (wardId) filter.wardId = wardId;
    if (roomId) filter.roomId = roomId;
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

// Get occupied beds with full details
exports.getOccupiedBeds = async (req, res) => {
  try {
    const beds = await Bed.find({ status: 'Occupied', isActive: true })
      .populate('roomId', 'room_number type')
      .populate('wardId', 'name floor')
      .populate({
        path: 'currentAdmissionId',
        select: 'admissionNumber patientId primaryDoctorId admissionDate status',
        populate: [
          { path: 'patientId', select: 'first_name last_name patientId uhid phone gender' },
          { path: 'primaryDoctorId', select: 'firstName lastName specialization' }
        ]
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
      .populate({
        path: 'currentAdmissionId',
        select: 'admissionNumber patientId primaryDoctorId admissionDate status',
        populate: [
          { path: 'patientId', select: 'first_name last_name patientId' },
          { path: 'primaryDoctorId', select: 'firstName lastName specialization' }
        ]
      });
    
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
    const { bedNumber, roomId, wardId, bedType, dailyCharge, features, status } = req.body;
    
    const bed = await Bed.findById(id);
    if (!bed) {
      return res.status(404).json({ error: 'Bed not found' });
    }
    
    // Update fields
    if (bedNumber) bed.bedNumber = bedNumber;
    if (roomId) bed.roomId = roomId;
    if (wardId !== undefined) bed.wardId = wardId;
    if (bedType) bed.bedType = bedType;
    if (dailyCharge !== undefined) bed.dailyCharge = dailyCharge;
    if (features) bed.features = features;
    if (status) bed.status = status;
    
    await bed.save();
    
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
    
    // If marking as Available, clear currentAdmissionId
    if (status === 'Available') {
      bed.currentAdmissionId = null;
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

// Delete bed (soft delete)
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

// ========== SYNC BED STATUS ==========
// Sync bed status with actual admissions
exports.syncBedStatus = async (req, res) => {
  try {
    // Get all beds that are marked as Occupied
    const occupiedBeds = await Bed.find({ status: 'Occupied', isActive: true });
    
    const updates = [];
    const errors = [];
    
    // Check occupied beds for active admissions
    for (const bed of occupiedBeds) {
      try {
        // Check if there's an active admission for this bed
        const activeAdmission = await IPDAdmission.findOne({
          bedId: bed._id,
          status: { 
            $in: ['Admitted', 'Under Treatment', 'Discharge Initiated', 
                  'Discharge Summary Pending', 'Billing Pending', 
                  'Payment Pending', 'Ready for Discharge'] 
          }
        });
        
        if (!activeAdmission) {
          // No active admission found - mark bed as Available
          bed.status = 'Available';
          bed.currentAdmissionId = null;
          await bed.save();
          updates.push({
            bedId: bed._id,
            bedNumber: bed.bedNumber,
            oldStatus: 'Occupied',
            newStatus: 'Available',
            reason: 'No active admission found'
          });
        } else {
          // Verify the currentAdmissionId matches
          if (!bed.currentAdmissionId || 
              bed.currentAdmissionId.toString() !== activeAdmission._id.toString()) {
            bed.currentAdmissionId = activeAdmission._id;
            await bed.save();
            updates.push({
              bedId: bed._id,
              bedNumber: bed.bedNumber,
              action: 'Updated currentAdmissionId',
              admissionId: activeAdmission._id,
              admissionNumber: activeAdmission.admissionNumber
            });
          }
        }
      } catch (err) {
        errors.push({
          bedId: bed._id,
          bedNumber: bed.bedNumber,
          error: err.message
        });
      }
    }
    
    // Also check for beds that are Available but have active admissions
    const availableBeds = await Bed.find({ status: 'Available', isActive: true });
    
    for (const bed of availableBeds) {
      try {
        const activeAdmission = await IPDAdmission.findOne({
          bedId: bed._id,
          status: { 
            $in: ['Admitted', 'Under Treatment', 'Discharge Initiated', 
                  'Discharge Summary Pending', 'Billing Pending', 
                  'Payment Pending', 'Ready for Discharge'] 
          }
        });
        
        if (activeAdmission) {
          bed.status = 'Occupied';
          bed.currentAdmissionId = activeAdmission._id;
          await bed.save();
          updates.push({
            bedId: bed._id,
            bedNumber: bed.bedNumber,
            oldStatus: 'Available',
            newStatus: 'Occupied',
            reason: 'Active admission found',
            admissionId: activeAdmission._id,
            admissionNumber: activeAdmission.admissionNumber
          });
        }
      } catch (err) {
        errors.push({
          bedId: bed._id,
          bedNumber: bed.bedNumber,
          error: err.message
        });
      }
    }
    
    res.json({
      success: true,
      message: 'Bed status synchronized successfully',
      summary: {
        totalUpdated: updates.length,
        totalErrors: errors.length
      },
      updates,
      errors
    });
  } catch (error) {
    console.error('Error syncing bed status:', error);
    res.status(500).json({ error: error.message });
  }
};