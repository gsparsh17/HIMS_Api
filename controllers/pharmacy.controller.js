const Pharmacy = require('../models/Pharmacy');
const User = require('../models/User');
const mongoose = require('mongoose');

// ========== CREATE PHARMACY ==========
exports.createPharmacy = async (req, res) => {
  try {
    const { name, licenseNumber, email, phone, address, password, status } = req.body;

    // Validate required fields
    if (!name || !licenseNumber || !email) {
      return res.status(400).json({
        success: false,
        error: 'Name, license number, and email are required'
      });
    }

    // Check if pharmacy already exists
    const existingPharmacy = await Pharmacy.findOne({
      $or: [
        { email: email.toLowerCase() },
        { licenseNumber: licenseNumber.toUpperCase() }
      ]
    });

    if (existingPharmacy) {
      return res.status(409).json({
        success: false,
        error: 'Pharmacy with this email or license number already exists'
      });
    }

    // Create pharmacy
    const pharmacy = new Pharmacy({
      name,
      licenseNumber: licenseNumber.toUpperCase(),
      email: email.toLowerCase(),
      phone: phone || '',
      address: address || '',
      status: status || 'Active'
    });

    await pharmacy.save();

    // Create associated user account if password provided
    let user = null;
    if (password) {
      user = new User({
        name,
        email: email.toLowerCase(),
        phone: phone || '',
        role: 'pharmacy',
        password,
        hospital_id: req.user?.hospital_id || null
      });
      await user.save();
    }

    res.status(201).json({
      success: true,
      message: 'Pharmacy created successfully',
      pharmacy: {
        _id: pharmacy._id,
        name: pharmacy.name,
        licenseNumber: pharmacy.licenseNumber,
        email: pharmacy.email,
        phone: pharmacy.phone,
        address: pharmacy.address,
        status: pharmacy.status,
        registeredAt: pharmacy.registeredAt
      },
      user: user ? {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      } : null
    });

  } catch (err) {
    console.error('Error creating pharmacy:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Pharmacy with this email or license number already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== GET ALL PHARMACIES ==========
exports.getAllPharmacies = async (req, res) => {
  try {
    const { status, search, limit = 50, page = 1 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { licenseNumber: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const pharmacies = await Pharmacy.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Pharmacy.countDocuments(filter);

    res.json({
      success: true,
      pharmacies,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (err) {
    console.error('Error fetching pharmacies:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== GET PHARMACY BY ID ==========
exports.getPharmacyById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pharmacy ID'
      });
    }

    const pharmacy = await Pharmacy.findById(id);

    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }

    // Get associated user if exists
    const user = await User.findOne({ email: pharmacy.email }).select('-password');

    res.json({
      success: true,
      pharmacy,
      user: user || null
    });

  } catch (err) {
    console.error('Error fetching pharmacy:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== UPDATE PHARMACY ==========
exports.updatePharmacy = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pharmacy ID'
      });
    }

    // Prevent email/license number conflicts
    if (updates.email || updates.licenseNumber) {
      const conflictQuery = {
        _id: { $ne: id },
        $or: []
      };

      if (updates.email) {
        conflictQuery.$or.push({ email: updates.email.toLowerCase() });
      }
      if (updates.licenseNumber) {
        conflictQuery.$or.push({ licenseNumber: updates.licenseNumber.toUpperCase() });
      }

      const conflict = await Pharmacy.findOne(conflictQuery);
      if (conflict) {
        return res.status(409).json({
          success: false,
          error: 'Another pharmacy already uses this email or license number'
        });
      }
    }

    // Clean up updates
    if (updates.email) updates.email = updates.email.toLowerCase();
    if (updates.licenseNumber) updates.licenseNumber = updates.licenseNumber.toUpperCase();

    const pharmacy = await Pharmacy.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }

    // Update associated user if email changed
    if (updates.email) {
      const user = await User.findOne({ email: updates.email });
      if (user) {
        if (updates.name) user.name = updates.name;
        if (updates.phone) user.phone = updates.phone;
        await user.save();
      }
    }

    res.json({
      success: true,
      message: 'Pharmacy updated successfully',
      pharmacy
    });

  } catch (err) {
    console.error('Error updating pharmacy:', err);
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Pharmacy with this email or license number already exists'
      });
    }
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== DELETE / DEACTIVATE PHARMACY ==========
exports.deletePharmacy = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pharmacy ID'
      });
    }

    const pharmacy = await Pharmacy.findById(id);

    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }

    // Soft delete - set status to Inactive
    pharmacy.status = 'Inactive';
    await pharmacy.save();

    // Also deactivate associated user if exists
    const user = await User.findOne({ email: pharmacy.email });
    if (user) {
      user.is_active = false;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Pharmacy deactivated successfully'
    });

  } catch (err) {
    console.error('Error deleting pharmacy:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== REACTIVATE PHARMACY ==========
exports.reactivatePharmacy = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pharmacy ID'
      });
    }

    const pharmacy = await Pharmacy.findById(id);

    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }

    pharmacy.status = 'Active';
    await pharmacy.save();

    // Also reactivate associated user if exists
    const user = await User.findOne({ email: pharmacy.email });
    if (user) {
      user.is_active = true;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Pharmacy reactivated successfully',
      pharmacy
    });

  } catch (err) {
    console.error('Error reactivating pharmacy:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// ========== GET PHARMACY STATISTICS ==========
exports.getPharmacyStatistics = async (req, res) => {
  try {
    const total = await Pharmacy.countDocuments();
    const active = await Pharmacy.countDocuments({ status: 'Active' });
    const inactive = await Pharmacy.countDocuments({ status: 'Inactive' });

    const recentPharmacies = await Pharmacy.find()
      .sort({ registeredAt: -1 })
      .limit(5);

    res.json({
      success: true,
      statistics: {
        total,
        active,
        inactive
      },
      recent: recentPharmacies
    });

  } catch (err) {
    console.error('Error fetching pharmacy statistics:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
};