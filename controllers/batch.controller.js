const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');

// Add new batch
exports.addBatch = async (req, res) => {
  try {
    const batch = new MedicineBatch(req.body);
    await batch.save();
    
    // Update medicine's stock (optional - can be calculated on demand)
    await Medicine.findByIdAndUpdate(
      batch.medicine_id,
      { $inc: { stock_quantity: batch.quantity } }
    );
    
    res.status(201).json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all batches with optional filtering
exports.getAllBatches = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = 'expiry_date',
      sortOrder = 'asc',
      medicineId,
      supplier,
      expiryThreshold
    } = req.query;
    
    // Build filter object
    const filter = {};
    
    if (medicineId) {
      filter.medicine_id = medicineId;
    }
    
    if (supplier) {
      filter.supplier = { $regex: supplier, $options: 'i' };
    }
    
    if (expiryThreshold) {
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() + parseInt(expiryThreshold));
      filter.expiry_date = { $lte: thresholdDate };
    }
    
    // Execute query with pagination
    const batches = await MedicineBatch.find(filter)
      .populate('medicine_id', 'name brand strength')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    // Get total count for pagination
    const total = await MedicineBatch.countDocuments(filter);
    
    res.json({
      batches,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get batches for medicine
exports.getBatchesByMedicine = async (req, res) => {
  try {
    const batches = await MedicineBatch.find({ 
      medicine_id: req.params.medicineId,
      quantity: { $gt: 0 }
    }).sort({ expiry_date: 1 });
    
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update batch
exports.updateBatch = async (req, res) => {
  try {
    const batch = await MedicineBatch.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get batches expiring soon (within 30 days)
exports.getExpiringBatches = async (req, res) => {
  try {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    
    const batches = await MedicineBatch.find({
      expiry_date: { 
        $gte: new Date(),
        $lte: thirtyDaysFromNow 
      },
      quantity: { $gt: 0 }
    }).populate('medicine_id');
    
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};