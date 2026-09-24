const StockAdjustment = require('../models/StockAdjustment');
const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const InventoryLedger = require('../models/InventoryLedger');
const mongoose = require('mongoose');
const { userHospitalId } = require('../utils/hospitalScope');

// Create stock adjustment
exports.createAdjustment = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { medicine_id, batch_id, adjustment_type, quantity, reason, notes } = req.body;
    if (!medicine_id || !adjustment_type || quantity === undefined || !reason) {
      return res.status(400).json({ error: 'Medicine, adjustment type, quantity, and reason are required.' });
    }

    const numQty = Number(quantity);
    if (!Number.isFinite(numQty) || numQty <= 0) {
      return res.status(400).json({ error: 'Quantity must be a positive number.' });
    }

    const stockChanging = ['Addition', 'Deduction', 'Damage', 'Expiry'].includes(adjustment_type);
    if (stockChanging && !batch_id) {
      return res.status(400).json({ error: 'A batch is required for stock-changing adjustments so inventory history remains auditable.' });
    }

    let createdAdjustment;
    await session.withTransaction(async () => {
      const hospitalId = userHospitalId(req.user);
      const medicine = await Medicine.findOne({ _id: medicine_id, ...(hospitalId ? { hospitalId } : {}) }).session(session);
      if (!medicine) throw Object.assign(new Error('Medicine not found for this hospital.'), { statusCode: 404 });

      let batch = null;
      let balanceAfter = null;
      let signedDelta = 0;
      if (batch_id) {
        batch = await MedicineBatch.findOne({ _id: batch_id, medicine_id }).session(session);
        if (!batch) throw Object.assign(new Error('Batch not found for this medicine.'), { statusCode: 404 });
        const before = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
        if (adjustment_type === 'Addition') signedDelta = numQty;
        if (['Deduction', 'Damage', 'Expiry'].includes(adjustment_type)) signedDelta = -numQty;
        if (signedDelta < 0 && before < Math.abs(signedDelta)) {
          throw Object.assign(new Error(`Adjustment exceeds available batch stock (${before}).`), { statusCode: 409 });
        }
        balanceAfter = before + signedDelta;
        if (signedDelta !== 0) {
          batch.quantity_base_units = balanceAfter;
          batch.quantity = balanceAfter;
          await batch.save({ session });
          medicine.stock_quantity = Math.max(0, Number(medicine.stock_quantity || 0) + signedDelta);
          await medicine.save({ session });
        }
      }

      const [adjustment] = await StockAdjustment.create([{
        medicine_id,
        batch_id: batch_id || null,
        adjustment_type,
        quantity: numQty,
        reason: String(reason).trim(),
        notes: notes ? String(notes).trim() : '',
        adjusted_by: req.user?._id || req.user?.id
      }], { session });
      createdAdjustment = adjustment;

      if (batch && signedDelta !== 0) {
        const movementType = adjustment_type === 'Addition'
          ? 'ADJUSTMENT_IN'
          : (['Damage', 'Expiry'].includes(adjustment_type) ? 'WASTE_OUT' : 'ADJUSTMENT_OUT');
        await InventoryLedger.create([{
          hospitalId: medicine.hospitalId || hospitalId,
          medicineId: medicine._id,
          batchId: batch._id,
          movementType,
          direction: signedDelta > 0 ? 'IN' : 'OUT',
          quantityBaseUnits: Math.abs(signedDelta),
          balanceAfterBaseUnits: balanceAfter,
          sourceModule: 'StockAdjustment',
          sourceId: adjustment._id,
          notes: `${adjustment_type}: ${String(reason).trim()}`,
          createdBy: req.user?._id || req.user?.id,
        }], { session });
      }
    });

    const populated = await StockAdjustment.findById(createdAdjustment._id)
      .populate('medicine_id', 'name generic_name brand category')
      .populate('adjusted_by', 'name email role')
      .populate('batch_id', 'batch_number expiry_date quantity quantity_base_units');
    return res.status(201).json({ success: true, adjustment: populated });
  } catch (err) {
    console.error('Error creating stock adjustment:', err);
    return res.status(err.statusCode || 400).json({ error: err.message || 'Failed to create stock adjustment' });
  } finally {
    await session.endSession();
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