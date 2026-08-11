const StockAdjustment = require('../models/StockAdjustment');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');

// Create stock adjustment
exports.createAdjustment = async (req, res) => {
  try {
    const { medicine_id, batch_id, adjustment_type, quantity, reason, notes } = req.body;
    
    if (!medicine_id || !adjustment_type || quantity === undefined || !reason) {
      return res.status(400).json({ error: 'Medicine, adjustment type, quantity, and reason are required.' });
    }

    const numQty = Number(quantity);
    if (isNaN(numQty) || numQty <= 0) {
      return res.status(400).json({ error: 'Quantity must be a positive number.' });
    }

    const adjustment = new StockAdjustment({
      medicine_id,
      batch_id: batch_id || null,
      adjustment_type,
      quantity: numQty,
      reason: String(reason).trim(),
      notes: notes ? String(notes).trim() : '',
      adjusted_by: req.user?._id || req.user?.id
    });
    
    await adjustment.save();
    
    // Update batch quantity if batch selected
    if (batch_id) {
      const batch = await MedicineBatch.findById(batch_id);
      if (batch) {
        if (adjustment_type === 'Addition') {
          batch.quantity = (batch.quantity || 0) + numQty;
          batch.quantity_base_units = (batch.quantity_base_units || 0) + numQty;
        } else if (['Deduction', 'Damage', 'Expiry'].includes(adjustment_type)) {
          batch.quantity = Math.max(0, (batch.quantity || 0) - numQty);
          batch.quantity_base_units = Math.max(0, (batch.quantity_base_units || 0) - numQty);
        }
        await batch.save();
      }
    }
    
    // Update medicine total stock
    const medicine = await Medicine.findById(medicine_id);
    if (medicine) {
      if (adjustment_type === 'Addition') {
        medicine.stock_quantity = (medicine.stock_quantity || 0) + numQty;
      } else if (['Deduction', 'Damage', 'Expiry'].includes(adjustment_type)) {
        medicine.stock_quantity = Math.max(0, (medicine.stock_quantity || 0) - numQty);
      }
      await medicine.save();
    }

    const populated = await StockAdjustment.findById(adjustment._id)
      .populate('medicine_id', 'name generic_name brand category')
      .populate('adjusted_by', 'name email role')
      .populate('batch_id', 'batch_number expiry_date');
    
    res.status(201).json({ success: true, adjustment: populated });
  } catch (err) {
    console.error('Error creating stock adjustment:', err);
    res.status(400).json({ error: err.message || 'Failed to create stock adjustment' });
  }
};

// Get adjustments for medicine
exports.getAdjustmentsByMedicine = async (req, res) => {
  try {
    const adjustments = await StockAdjustment.find({
      medicine_id: req.params.medicineId
    })
    .populate('medicine_id', 'name generic_name brand category')
    .populate('adjusted_by', 'name email role')
    .populate('batch_id', 'batch_number expiry_date')
    .sort({ createdAt: -1 });
    
    res.json(adjustments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get all adjustments
exports.getAllAdjustments = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    
    const adjustments = await StockAdjustment.find()
      .populate('medicine_id', 'name generic_name brand category')
      .populate('adjusted_by', 'name email role')
      .populate('batch_id', 'batch_number expiry_date')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await StockAdjustment.countDocuments();
    
    res.json({
      success: true,
      adjustments: Array.isArray(adjustments) ? adjustments : [],
      totalPages: Math.ceil(total / limit),
      currentPage: Number(page),
      total
    });
  } catch (err) {
    console.error('Error fetching stock adjustments:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch stock adjustments' });
  }
};