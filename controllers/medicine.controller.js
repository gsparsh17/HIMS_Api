const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');

// Add new medicine
exports.addMedicine = async (req, res) => {
  try {
    const medicine = new Medicine(req.body);
    await medicine.save();
    res.status(201).json(medicine);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all medicines (non-expired)
exports.getAllMedicines = async (req, res) => {
  try {
    const medicines = await Medicine.find({ is_active: true })
      .sort({ name: 1 });
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get medicine by ID
exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id);
    //   .populate('batches');
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    res.json(medicine);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update medicine
exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true, runValidators: true }
    );
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    res.json(medicine);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete medicine (soft delete)
exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findByIdAndUpdate(
      req.params.id,
      { is_active: false },
      { new: true }
    );
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    res.json({ message: 'Medicine deactivated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get expired medicines
exports.getExpiredMedicines = async (req, res) => {
  try {
    const today = new Date();
    const batches = await MedicineBatch.find({ 
      expiry_date: { $lt: today },
      quantity: { $gt: 0 }
    }).populate('medicine_id');
    
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get low stock medicines
exports.getLowStockMedicines = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    
    const medicines = await Medicine.aggregate([
      {
        $lookup: {
          from: 'medicinebatches',
          localField: '_id',
          foreignField: 'medicine_id',
          as: 'batches'
        }
      },
      {
        $addFields: {
          total_stock: {
            $sum: '$batches.quantity'
          }
        }
      },
      {
        $match: {
          total_stock: { $lt: threshold },
          is_active: true
        }
      }
    ]);
    
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Search medicines
exports.searchMedicines = async (req, res) => {
  try {
    const { query } = req.query;
    const medicines = await Medicine.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { generic_name: { $regex: query, $options: 'i' } },
        { brand: { $regex: query, $options: 'i' } }
      ],
      is_active: true
    });
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};