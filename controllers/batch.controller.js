const MedicineBatch = require('../models/MedicineBatch');
const Medicine = require('../models/Medicine');

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
  try {
    const batch = new MedicineBatch(req.body);
    if (!(Number(batch.selling_price_per_pack ?? batch.selling_price) > 0)) {
      return res.status(400).json({ error: 'Selling price must be greater than zero' });
    }

    const mrpPerPack = Number(batch.mrp_per_pack ?? 0);
    const sellingPerPack = Number(batch.selling_price_per_pack ?? batch.selling_price ?? 0);
    if (mrpPerPack > 0 && sellingPerPack - mrpPerPack > 0.009) {
      return res.status(400).json({ error: 'Selling price cannot exceed MRP' });
    }

    await batch.save();

    // Legacy/single-hospital deployment: the database is the tenant boundary.
    // MedicineBatch is intentionally not scoped by hospitalId.
    await Medicine.findByIdAndUpdate(
      batch.medicine_id,
      { $inc: { stock_quantity: Number(batch.quantity_base_units ?? batch.quantity ?? 0) } }
    );

    res.status(201).json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  try {
    const update = { ...req.body };
    // hospitalId may exist on some historical records, but is not required or
    // used as an inventory boundary in a single-hospital database.
    delete update.hospitalId;
    delete update.hospital_id;

    const nextSellingPerPack = Number(update.selling_price_per_pack ?? update.selling_price ?? NaN);
    if (Number.isFinite(nextSellingPerPack) && !(nextSellingPerPack > 0)) {
      return res.status(400).json({ error: 'Selling price must be greater than zero' });
    }
    const nextMrpPerPack = Number(update.mrp_per_pack ?? NaN);
    if (Number.isFinite(nextMrpPerPack) && Number.isFinite(nextSellingPerPack) && nextMrpPerPack > 0 && nextSellingPerPack - nextMrpPerPack > 0.009) {
      return res.status(400).json({ error: 'Selling price cannot exceed MRP' });
    }

    const batch = await MedicineBatch.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json(batch);
  } catch (err) {
    res.status(400).json({ error: err.message });
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
