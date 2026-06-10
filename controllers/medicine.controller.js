const mongoose = require('mongoose');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');

// Helper function to validate GST rate (India specific)
const validateGSTRate = (rate) => {
  const gstRate = parseFloat(rate);
  if (isNaN(gstRate)) return false;
  // Valid GST rates in India: 0, 5, 12, 18, 28
  const validRates = [0, 5, 12, 18, 28];
  return validRates.includes(gstRate);
};

// Helper function to validate HSN code
const validateHSNCode = (code) => {
  if (!code || code.trim() === '') return false; // HSN is required for GST compliance
  return /^\d{4,8}$/.test(code.trim());
};

// Helper to track who made changes
const getUserId = (req) => {
  return req.user?._id || req.user?.id || null;
};

// Add new medicine with tax validation
exports.addMedicine = async (req, res) => {
  try {
    // Validate HSN code is required
    if (!req.body.hsn_code) {
      return res.status(400).json({ error: 'HSN code is required for GST compliance' });
    }
    
    // Validate HSN code format
    if (!validateHSNCode(req.body.hsn_code)) {
      return res.status(400).json({ error: 'HSN code must be 4-8 digits' });
    }
    req.body.hsn_code = req.body.hsn_code.trim().toUpperCase();
    
    // Validate GST rate
    if (req.body.gst_rate === undefined || req.body.gst_rate === null) {
      return res.status(400).json({ error: 'GST rate is required' });
    }
    
    if (!validateGSTRate(req.body.gst_rate)) {
      return res.status(400).json({ error: 'GST rate must be one of: 0, 5, 12, 18, 28' });
    }
    req.body.gst_rate = parseFloat(req.body.gst_rate);
    
    // Initialize GST history
    req.body.gst_history = [{
      hsn_code: req.body.hsn_code,
      gst_rate: req.body.gst_rate,
      effective_from: new Date(),
      reason: 'Initial setup',
      changed_by: getUserId(req)
    }];
    
    const medicine = new Medicine(req.body);
    await medicine.save();
    
    res.status(201).json({
      success: true,
      message: 'Medicine added successfully',
      medicine
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all medicines with stock and tax info
exports.getAllMedicines = async (req, res) => {
  try {
    const medicines = await Medicine.find({ is_active: true })
      .sort({ name: 1 });
    
    const medicinesWithStock = await Promise.all(
      medicines.map(async (medicine) => {
        const medicineObj = medicine.toObject();
        
        const batches = await MedicineBatch.find({ 
          medicine_id: medicine._id,
          is_active: true,
          quantity: { $gt: 0 }
        });
        
        const totalStock = batches.reduce((sum, batch) => sum + (batch.quantity || 0), 0);
        const earliestExpiry = batches.length > 0 
          ? batches.reduce((earliest, batch) => 
              batch.expiry_date < earliest ? batch.expiry_date : earliest, 
              batches[0].expiry_date
            )
          : null;
        const totalValue = batches.reduce((sum, batch) => 
          sum + ((batch.purchase_price || 0) * (batch.quantity || 0)), 0
        );
        
        return {
          ...medicineObj,
          stock_quantity: totalStock,
          batch_count: batches.length,
          earliest_expiry: earliestExpiry,
          total_stock_value: totalValue,
          batches,
          tax_info: {
            hsn_code: medicineObj.hsn_code,
            gst_rate: medicineObj.gst_rate,
            cgst_rate: (medicineObj.gst_rate || 0) / 2,
            sgst_rate: (medicineObj.gst_rate || 0) / 2,
            is_valid: validateGSTRate(medicineObj.gst_rate)
          }
        };
      })
    );
    
    res.json(medicinesWithStock);
  } catch (err) {
    console.error('Error fetching medicines:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get single medicine with stock details and tax info
exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: 'Medicine not found' });
    }
    
    const batches = await MedicineBatch.find({ 
      medicine_id: medicine._id,
      is_active: true 
    }).sort({ expiry_date: 1 }).populate('supplier_id', 'name');
    
    const totalStock = batches.reduce((sum, batch) => sum + (batch.quantity || 0), 0);
    
    const stockByExpiry = batches.map(batch => ({
      batch_id: batch._id,
      batch_number: batch.batch_number,
      expiry_date: batch.expiry_date,
      quantity: batch.quantity,
      quantity_base_units: batch.quantity_base_units,
      selling_price: batch.selling_price,
      selling_price_per_base_unit: batch.selling_price_per_base_unit,
      purchase_price: batch.purchase_price,
      supplier: batch.supplier_id,
      // Tax snapshot at batch creation time (for audit)
      tax_at_purchase: batch.tax_snapshot
    }));
    
    const medicineObj = medicine.toObject();
    res.json({
      ...medicineObj,
      stock_quantity: totalStock,
      batch_count: batches.length,
      batches: stockByExpiry,
      tax_info: {
        hsn_code: medicineObj.hsn_code,
        gst_rate: medicineObj.gst_rate,
        cgst_rate: (medicineObj.gst_rate || 0) / 2,
        sgst_rate: (medicineObj.gst_rate || 0) / 2,
        is_valid: validateGSTRate(medicineObj.gst_rate),
        history: medicineObj.gst_history || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update medicine with tax validation and history tracking
exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findById(req.params.id);
    if (!medicine) {
      return res.status(404).json({ error: 'Medicine not found' });
    }
    
    // Track if tax information is being changed
    const taxChanged = (req.body.hsn_code && req.body.hsn_code !== medicine.hsn_code) ||
                       (req.body.gst_rate !== undefined && req.body.gst_rate !== medicine.gst_rate);
    
    // Validate HSN code if provided
    if (req.body.hsn_code !== undefined) {
      if (!validateHSNCode(req.body.hsn_code)) {
        return res.status(400).json({ error: 'HSN code must be 4-8 digits' });
      }
      req.body.hsn_code = req.body.hsn_code.trim().toUpperCase();
    }
    
    // Validate GST rate if provided
    if (req.body.gst_rate !== undefined) {
      if (!validateGSTRate(req.body.gst_rate)) {
        return res.status(400).json({ error: 'GST rate must be one of: 0, 5, 12, 18, 28' });
      }
      req.body.gst_rate = parseFloat(req.body.gst_rate);
    }
    
    // If tax changed, add to history
    if (taxChanged) {
      const historyEntry = {
        hsn_code: req.body.hsn_code || medicine.hsn_code,
        gst_rate: req.body.gst_rate !== undefined ? req.body.gst_rate : medicine.gst_rate,
        effective_from: new Date(),
        reason: req.body.tax_change_reason || 'Manual update',
        changed_by: getUserId(req)
      };
      
      req.body.gst_history = [...(medicine.gst_history || []), historyEntry];
    }
    
    const updatedMedicine = await Medicine.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true, runValidators: true }
    );
    
    res.json({
      success: true,
      message: taxChanged ? 'Medicine updated. Tax history recorded.' : 'Medicine updated.',
      medicine: updatedMedicine
    });
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
    }).populate('medicine_id', 'name hsn_code gst_rate');
    
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
      },
      {
        $project: {
          name: 1,
          generic_name: 1,
          hsn_code: 1,
          gst_rate: 1,
          total_stock: 1,
          min_stock_level: 1
        }
      }
    ]);
    
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Search medicines with tax info
exports.searchMedicines = async (req, res) => {
  try {
    const { query, q, includeBatches = 'true', limit = 20 } = req.query;
    const searchTerm = String(query || q || '').trim();

    if (!searchTerm || searchTerm.length < 2) {
      return res.json([]);
    }

    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = escapedTerm.split(/\s+/).filter(Boolean).join('|');

    const batchMatches = await MedicineBatch.find({
      batch_number: { $regex: escapedTerm, $options: 'i' },
      is_active: true
    }).select('medicine_id').limit(Number(limit));

    const medicineQuery = {
      is_active: true,
      $or: [
        { name: { $regex: escapedTerm, $options: 'i' } },
        { generic_name: { $regex: escapedTerm, $options: 'i' } },
        { brand: { $regex: escapedTerm, $options: 'i' } },
        { category: { $regex: escapedTerm, $options: 'i' } },
        { composition: { $regex: escapedTerm, $options: 'i' } },
        { composition_keywords: { $regex: escapedTerm.toLowerCase(), $options: 'i' } },
        { hsn_code: { $regex: escapedTerm, $options: 'i' } },
        { name: { $regex: wordRegex, $options: 'i' } },
        ...(batchMatches.length ? [{ _id: { $in: batchMatches.map(b => b.medicine_id) } }] : [])
      ]
    };

    const medicines = await Medicine.find(medicineQuery)
      .limit(Number(limit))
      .select('name generic_name composition compositions brand strength category hsn_code gst_rate base_unit pack_unit units_per_pack allow_loose_sale min_stock_level location prescription_required is_own_brand manufacturer')
      .lean();

    if (includeBatches === 'false') {
      return res.json(medicines);
    }

    const medicineIds = medicines.map(m => m._id);
    const batches = await MedicineBatch.find({
      medicine_id: { $in: medicineIds },
      is_active: true,
      quantity_base_units: { $gt: 0 }
    })
      .sort({ expiry_date: 1 })
      .select('medicine_id batch_number expiry_date quantity quantity_base_units units_per_pack selling_price selling_price_per_pack selling_price_per_base_unit mrp_per_pack')
      .lean();

    const batchesByMedicine = batches.reduce((acc, batch) => {
      const key = String(batch.medicine_id);
      if (!acc[key]) acc[key] = [];
      acc[key].push(batch);
      return acc;
    }, {});

    const rows = medicines.map(medicine => {
      const medBatches = batchesByMedicine[String(medicine._id)] || [];
      const stock = medBatches.reduce((sum, batch) => sum + Number(batch.quantity_base_units ?? batch.quantity ?? 0), 0);
      return {
        ...medicine,
        stock_quantity: stock,
        batch_count: medBatches.length,
        earliest_expiry: medBatches[0]?.expiry_date || null,
        batches: medBatches,
        tax_info: {
          hsn_code: medicine.hsn_code,
          gst_rate: medicine.gst_rate,
          cgst_rate: (medicine.gst_rate || 0) / 2,
          sgst_rate: (medicine.gst_rate || 0) / 2,
          is_valid: validateGSTRate(medicine.gst_rate)
        }
      };
    });

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.json(rows);
  } catch (err) {
    console.error('Error searching medicines:', err);
    res.status(500).json({ error: err.message });
  }
};

// ============== GST / TAX REPORTING ENDPOINTS ==============

// Get medicines by HSN code
exports.getMedicinesByHSN = async (req, res) => {
  try {
    const { hsnCode } = req.params;
    const medicines = await Medicine.find({ 
      hsn_code: { $regex: new RegExp(`^${hsnCode}$`, 'i') },
      is_active: true 
    }).select('name brand hsn_code gst_rate composition category');
    
    res.json({
      success: true,
      count: medicines.length,
      medicines,
      hsn_code: hsnCode
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get GST summary report
exports.getGSTSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = { is_active: true };
    if (startDate && endDate) {
      matchStage.created_at = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    // Aggregate GST by HSN code
    const gstSummary = await Medicine.aggregate([
      { $match: matchStage },
      { 
        $match: { 
          hsn_code: { $ne: null, $ne: '' }
        } 
      },
      {
        $group: {
          _id: { hsn_code: '$hsn_code', gst_rate: '$gst_rate' },
          hsn_code: { $first: '$hsn_code' },
          gst_rate: { $first: '$gst_rate' },
          medicine_count: { $sum: 1 },
          medicines: { $push: { name: '$name', brand: '$brand', composition: '$composition' } }
        }
      },
      { $sort: { hsn_code: 1 } }
    ]);
    
    // Calculate GST rate distribution
    const rateDistribution = await Medicine.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$gst_rate',
          rate: { $first: '$gst_rate' },
          count: { $sum: 1 },
          medicines: { $push: { name: '$name', hsn_code: '$hsn_code' } }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Get medicines without HSN (non-compliant)
    const missingHSN = await Medicine.countDocuments({
      ...matchStage,
      $or: [
        { hsn_code: { $eq: null, $eq: '' } },
        { hsn_code: { $exists: false } }
      ]
    });
    
    // Get medicines with invalid GST rates
    const invalidGST = await Medicine.countDocuments({
      ...matchStage,
      gst_rate: { $nin: [0, 5, 12, 18, 28] }
    });
    
    res.json({
      success: true,
      summary: {
        total_medicines: await Medicine.countDocuments(matchStage),
        total_medicines_with_gst: gstSummary.reduce((sum, item) => sum + item.medicine_count, 0),
        unique_hsn_codes: gstSummary.length,
        medicines_missing_hsn: missingHSN,
        medicines_with_invalid_gst: invalidGST,
        gst_rate_distribution: rateDistribution.map(r => ({ rate: r.rate, count: r.count }))
      },
      by_hsn: gstSummary,
      by_rate: rateDistribution
    });
  } catch (err) {
    console.error('Error getting GST summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// Bulk update GST rates for medicines (with history tracking)
exports.bulkUpdateGST = async (req, res) => {
  try {
    const { updates, reason } = req.body;
    
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }
    
    const results = [];
    const errors = [];
    const userId = getUserId(req);
    
    for (const update of updates) {
      try {
        const { medicineId, hsn_code, gst_rate } = update;
        
        if (!medicineId) {
          errors.push({ medicineId, error: 'Medicine ID is required' });
          continue;
        }
        
        const medicine = await Medicine.findById(medicineId);
        if (!medicine) {
          errors.push({ medicineId, error: 'Medicine not found' });
          continue;
        }
        
        const updateData = {};
        const taxChanged = false;
        
        // Validate and set HSN
        if (hsn_code !== undefined) {
          if (!validateHSNCode(hsn_code)) {
            errors.push({ medicineId, error: 'HSN code must be 4-8 digits' });
            continue;
          }
          updateData.hsn_code = hsn_code.trim().toUpperCase();
        }
        
        // Validate and set GST rate
        if (gst_rate !== undefined) {
          if (!validateGSTRate(gst_rate)) {
            errors.push({ medicineId, error: 'GST rate must be one of: 0, 5, 12, 18, 28' });
            continue;
          }
          updateData.gst_rate = parseFloat(gst_rate);
        }
        
        // Track tax change in history
        if ((updateData.hsn_code && updateData.hsn_code !== medicine.hsn_code) ||
            (updateData.gst_rate !== undefined && updateData.gst_rate !== medicine.gst_rate)) {
          const historyEntry = {
            hsn_code: updateData.hsn_code || medicine.hsn_code,
            gst_rate: updateData.gst_rate !== undefined ? updateData.gst_rate : medicine.gst_rate,
            effective_from: new Date(),
            reason: reason || 'Bulk update',
            changed_by: userId
          };
          updateData.gst_history = [...(medicine.gst_history || []), historyEntry];
        }
        
        const updatedMedicine = await Medicine.findByIdAndUpdate(
          medicineId,
          updateData,
          { new: true }
        );
        
        results.push({ 
          medicineId, 
          name: updatedMedicine.name,
          hsn_code: updatedMedicine.hsn_code,
          gst_rate: updatedMedicine.gst_rate 
        });
      } catch (err) {
        errors.push({ medicineId: update.medicineId, error: err.message });
      }
    }
    
    res.json({
      success: true,
      message: `Updated ${results.length} medicines, ${errors.length} failed`,
      updated_count: results.length,
      failed_count: errors.length,
      results,
      errors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Export GST data to CSV
exports.exportGSTData = async (req, res) => {
  try {
    const medicines = await Medicine.find({ is_active: true })
      .select('name brand hsn_code gst_rate composition category manufacturer')
      .sort({ hsn_code: 1, name: 1 })
      .lean();
    
    const headers = [
      'Medicine Name', 
      'Brand', 
      'Composition', 
      'Category',
      'Manufacturer',
      'HSN Code', 
      'GST Rate (%)', 
      'CGST (%)', 
      'SGST (%)',
      'GST Valid'
    ];
    
    const rows = medicines.map(med => [
      med.name,
      med.brand || '',
      med.composition || '',
      med.category || '',
      med.manufacturer || '',
      med.hsn_code || '',
      med.gst_rate || 0,
      ((med.gst_rate || 0) / 2).toFixed(2),
      ((med.gst_rate || 0) / 2).toFixed(2),
      validateGSTRate(med.gst_rate) ? 'Yes' : 'No'
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=gst_data_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get tax history for a medicine (audit trail)
exports.getMedicineTaxHistory = async (req, res) => {
  try {
    const { id } = req.params;
    
    const medicine = await Medicine.findById(id)
      .select('name hsn_code gst_rate gst_history');
    
    if (!medicine) {
      return res.status(404).json({ error: 'Medicine not found' });
    }
    
    // Get batches with their tax snapshots
    const batches = await MedicineBatch.find({ 
      medicine_id: id,
      is_active: true 
    }).select('batch_number tax_snapshot purchase_date received_date');
    
    res.json({
      success: true,
      medicine: {
        id: medicine._id,
        name: medicine.name,
        current_hsn: medicine.hsn_code,
        current_gst: medicine.gst_rate,
        current_gst_valid: validateGSTRate(medicine.gst_rate),
        tax_history: medicine.gst_history || []
      },
      batches: batches.map(b => ({
        batch_number: b.batch_number,
        purchase_date: b.purchase_date,
        received_date: b.received_date,
        tax_at_purchase: b.tax_snapshot
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get GST compliant medicines (for reporting)
exports.getGSTCompliantMedicines = async (req, res) => {
  try {
    const compliant = await Medicine.find({
      is_active: true,
      hsn_code: { $ne: null, $ne: '' },
      gst_rate: { $in: [0, 5, 12, 18, 28] }
    }).countDocuments();
    
    const nonCompliant = await Medicine.find({
      is_active: true,
      $or: [
        { hsn_code: { $eq: null, $eq: '' } },
        { gst_rate: { $nin: [0, 5, 12, 18, 28] } }
      ]
    }).countDocuments();
    
    res.json({
      success: true,
      compliant_count: compliant,
      non_compliant_count: nonCompliant,
      total_active: compliant + nonCompliant,
      compliance_percentage: ((compliant / (compliant + nonCompliant)) * 100).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};