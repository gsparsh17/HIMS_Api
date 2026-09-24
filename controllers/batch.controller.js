const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');
const InventoryLedger = require('../models/InventoryLedger');
const mongoose = require('mongoose');

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function inStockFilter() {
  return { $or: [{ quantity_base_units: { $gt: 0 } }, { quantity: { $gt: 0 } }] };
}

// Add new batch
exports.addBatch = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const medicine = await Medicine.findById(req.body.medicine_id).session(session);
      if (!medicine) throw Object.assign(new Error('Medicine not found'), { statusCode: 404 });

      const batch = new MedicineBatch(req.body);
      if (!(Number(batch.selling_price_per_pack ?? batch.selling_price) > 0)) {
        throw Object.assign(new Error('Selling price must be greater than zero'), { statusCode: 400 });
      }
      const mrpPerPack = Number(batch.mrp_per_pack ?? 0);
      const sellingPerPack = Number(batch.selling_price_per_pack ?? batch.selling_price ?? 0);
      if (mrpPerPack > 0 && sellingPerPack - mrpPerPack > 0.009) {
        throw Object.assign(new Error('Selling price cannot exceed MRP'), { statusCode: 400 });
      }

      await batch.save({ session });
      const openingQty = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
      medicine.stock_quantity = Number(medicine.stock_quantity || 0) + openingQty;
      await medicine.save({ session });

      if (openingQty > 0) {
        await InventoryLedger.create([{
          hospitalId: medicine.hospitalId,
          medicineId: medicine._id,
          batchId: batch._id,
          movementType: 'OPENING',
          direction: 'IN',
          quantityBaseUnits: openingQty,
          balanceAfterBaseUnits: openingQty,
          sourceModule: 'Manual',
          sourceId: batch._id,
          notes: `Batch ${batch.batch_number} opening stock`,
          createdBy: req.user?._id || req.user?.id,
        }], { session });
      }
      created = batch;
    });
    return res.status(201).json(created);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  } finally {
    await session.endSession();
  }
};

// Get all batches with optional filtering. Inventory management can include
// expired batches; sale/dispense endpoints use getBatchesByMedicine below.
exports.getAllBatches = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = 'expiry_date',
      sortOrder = 'asc',
      medicineId,
      medicine_id,
      supplier,
      expiryThreshold
    } = req.query;

    const filter = {};
    const medFilter = medicineId || medicine_id;
    if (medFilter) filter.medicine_id = medFilter;
    if (supplier) filter.supplier_id = supplier;

    if (expiryThreshold) {
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() + parseInt(expiryThreshold, 10));
      filter.expiry_date = { $lte: thresholdDate };
    }

    const numericLimit = Number(limit);
    const numericPage = Number(page);
    const batches = await MedicineBatch.find(filter)
      .populate('medicine_id', 'name brand strength')
      .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
      .limit(numericLimit)
      .skip((numericPage - 1) * numericLimit);

    const total = await MedicineBatch.countDocuments(filter);

    res.json({
      batches,
      totalPages: Math.ceil(total / numericLimit),
      currentPage: numericPage,
      total
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Sale/dispense batch selector: active, in-stock and non-expired only.
exports.getBatchesByMedicine = async (req, res) => {
  try {
    const today = startOfToday();
    const batches = await MedicineBatch.find({
      medicine_id: req.params.medicineId,
      is_active: true,
      expiry_date: { $gt: today },
      ...inStockFilter()
    }).sort({ expiry_date: 1 });

    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update batch
exports.updateBatch = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let updatedBatch;
    await session.withTransaction(async () => {
      const update = { ...req.body };
      delete update.hospitalId;
      delete update.hospital_id;

      const batch = await MedicineBatch.findById(req.params.id).session(session);
      if (!batch) throw Object.assign(new Error('Batch not found'), { statusCode: 404 });
      const medicine = await Medicine.findById(batch.medicine_id).session(session);
      if (!medicine) throw Object.assign(new Error('Medicine not found'), { statusCode: 404 });

      const nextSellingPerPack = Number(update.selling_price_per_pack ?? update.selling_price ?? NaN);
      if (Number.isFinite(nextSellingPerPack) && !(nextSellingPerPack > 0)) {
        throw Object.assign(new Error('Selling price must be greater than zero'), { statusCode: 400 });
      }
      const nextMrpPerPack = Number(update.mrp_per_pack ?? NaN);
      if (Number.isFinite(nextMrpPerPack) && Number.isFinite(nextSellingPerPack) && nextMrpPerPack > 0 && nextSellingPerPack - nextMrpPerPack > 0.009) {
        throw Object.assign(new Error('Selling price cannot exceed MRP'), { statusCode: 400 });
      }

      const beforeQty = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
      let nextQty = beforeQty;
      if (update.quantity_base_units !== undefined || update.quantity !== undefined) {
        nextQty = Number(update.quantity_base_units ?? update.quantity);
        if (!Number.isFinite(nextQty) || nextQty < 0) throw Object.assign(new Error('Batch quantity must be zero or greater'), { statusCode: 400 });
        update.quantity_base_units = nextQty;
        update.quantity = nextQty;
      }

      Object.assign(batch, update);
      await batch.save({ session });
      const delta = nextQty - beforeQty;
      if (Math.abs(delta) > 1e-9) {
        medicine.stock_quantity = Math.max(0, Number(medicine.stock_quantity || 0) + delta);
        await medicine.save({ session });
        await InventoryLedger.create([{
          hospitalId: medicine.hospitalId,
          medicineId: medicine._id,
          batchId: batch._id,
          movementType: delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
          direction: delta > 0 ? 'IN' : 'OUT',
          quantityBaseUnits: Math.abs(delta),
          balanceAfterBaseUnits: nextQty,
          sourceModule: 'Manual',
          sourceId: batch._id,
          notes: 'Batch quantity edited directly',
          createdBy: req.user?._id || req.user?.id,
        }], { session });
      }
      updatedBatch = batch;
    });
    return res.json(updatedBatch);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  } finally {
    await session.endSession();
  }
};

// Get batches expiring soon (within 30 days), excluding already-expired stock.
exports.getExpiringBatches = async (req, res) => {
  try {
    const today = startOfToday();
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const batches = await MedicineBatch.find({
      expiry_date: { $gt: today, $lte: thirtyDaysFromNow },
      is_active: true,
      ...inStockFilter()
    }).populate('medicine_id');

    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
