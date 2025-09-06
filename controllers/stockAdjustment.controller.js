const StockAdjustment = require('../models/StockAdjustment');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');

// Create stock adjustment
exports.createAdjustment = async (req, res) => {
  try {
    const { medicine_id, batch_id, adjustment_type, quantity, reason, notes } = req.body;
    
    const adjustment = new StockAdjustment({
      medicine_id,
      batch_id,
      adjustment_type,
      quantity,
      reason,
      notes,
      adjusted_by: req.user._id
    });
    
    await adjustment.save();
    
    // Update batch quantity
    if (batch_id) {
      const batch = await MedicineBatch.findById(batch_id);
      if (batch) {
        if (adjustment_type === 'Addition') {
          batch.quantity += quantity;
        } else if (['Deduction', 'Damage', 'Expiry'].includes(adjustment_type)) {
          batch.quantity = Math.max(0, batch.quantity - quantity);
        }
        await batch.save();
      }
    }
    
    // Also update medicine total stock
    const medicine = await Medicine.findById(medicine_id);
    if (medicine) {
      if (adjustment_type === 'Addition') {
        medicine.stock_quantity += quantity;
      } else if (['Deduction', 'Damage', 'Expiry'].includes(adjustment_type)) {
        medicine.stock_quantity = Math.max(0, medicine.stock_quantity - quantity);
      }
      await medicine.save();
    }
    
    res.status(201).json(adjustment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get adjustments for medicine
exports.getAdjustmentsByMedicine = async (req, res) => {
  try {
    const adjustments = await StockAdjustment.find({
      medicine_id: req.params.medicineId
    })
    .populate('adjusted_by', 'name')
    .populate('batch_id')
    .sort({ createdAt: -1 });
    
    res.json(adjustments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get all adjustments
exports.getAllAdjustments = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const adjustments = await StockAdjustment.find()
      .populate('medicine_id', 'name')
      .populate('adjusted_by', 'name')
      .populate('batch_id')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await StockAdjustment.countDocuments();
    
    res.json({
      adjustments,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};