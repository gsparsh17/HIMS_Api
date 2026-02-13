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
// Updated controller to include stock quantity from batches
exports.getAllMedicines = async (req, res) => {
  try {
    // Get all active medicines
    const medicines = await Medicine.find({ is_active: true })
      .sort({ name: 1 });
    
    // For each medicine, calculate total stock from batches
    const medicinesWithStock = await Promise.all(
      medicines.map(async (medicine) => {
        // Convert to plain object so we can add fields
        const medicineObj = medicine.toObject();
        
        // Get all active batches for this medicine
        const batches = await MedicineBatch.find({ 
          medicine_id: medicine._id,
          is_active: true,
          quantity: { $gt: 0 } // Only batches with positive quantity
        });
        
        // Calculate total stock quantity
        const totalStock = batches.reduce((sum, batch) => sum + (batch.quantity || 0), 0);
        
        // Get earliest expiry date among batches (for stock alerts)
        const earliestExpiry = batches.length > 0 
          ? batches.reduce((earliest, batch) => 
              batch.expiry_date < earliest ? batch.expiry_date : earliest, 
              batches[0].expiry_date
            )
          : null;
        
        // Get total value of stock (purchase price * quantity)
        const totalValue = batches.reduce((sum, batch) => 
          sum + ((batch.purchase_price || 0) * (batch.quantity || 0)), 0
        );
        
        return {
          ...medicineObj,
          stock_quantity: totalStock,
          batch_count: batches.length,
          earliest_expiry: earliestExpiry,
          total_stock_value: totalValue,
          batches: batches // Include batch details if needed
        };
      })
    );
    
    res.json(medicinesWithStock);
  } catch (err) {
    console.error('Error fetching medicines with stock:', err);
    res.status(500).json({ error: err.message });
  }
};

// Optional: Get single medicine with stock details
exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: 'Medicine not found' });
    }
    
    // Get all batches for this medicine
    const batches = await MedicineBatch.find({ 
      medicine_id: medicine._id,
      is_active: true 
    }).sort({ expiry_date: 1 }); // Sort by expiry date (soonest first)
    
    // Calculate total stock
    const totalStock = batches.reduce((sum, batch) => sum + (batch.quantity || 0), 0);
    
    // Get stock by expiry
    const stockByExpiry = batches.map(batch => ({
      batch_number: batch.batch_number,
      expiry_date: batch.expiry_date,
      quantity: batch.quantity,
      selling_price: batch.selling_price,
      purchase_price: batch.purchase_price,
      supplier_id: batch.supplier_id
    }));
    
    const medicineObj = medicine.toObject();
    res.json({
      ...medicineObj,
      stock_quantity: totalStock,
      batch_count: batches.length,
      batches: stockByExpiry
    });
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