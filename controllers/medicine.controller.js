'use strict';

const mongoose = require('mongoose');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const EmergencyMedicationChecklist = require('../models/EmergencyMedicationChecklist');
const { requestHospitalId } = require('../utils/hospitalScope');



function hospitalIdFor(req) {
  return requestHospitalId(req);
}

function medicineScope(req, extra = {}) {
  return { hospitalId: hospitalIdFor(req), ...extra };
}

// Helper function to validate GST rate (India specific)
const validateGSTRate = (rate) => {
  const gstRate = parseFloat(rate);

  if (isNaN(gstRate)) {
    return false;
  }

  // Valid GST rates in India: 0, 5, 12, 18, 28
  const validRates = [0, 5, 12, 18, 28];
  return validRates.includes(gstRate);
};

// Helper function to validate HSN code
const validateHSNCode = (code) => {
  if (!code || code.trim() === '') {
    return false; // HSN is required for GST compliance
  }

  return /^\d{4,8}$/.test(code.trim());
};

// Helper to track who made changes
const getUserId = (req) => {
  return req.user?._id || req.user?.id || null;
};

// Add new medicine with source-master and tax-compliance support
exports.addMedicine = async (req, res) => {
  try {
    const body = { ...req.body };

    body.hospitalId = hospitalIdFor(req);
    body.generic_name = String(body.generic_name || body.genericSaltName || body.generic_salt_name || '').trim();
    body.brand = String(body.brand || body.brand_name || '').trim();
    body.name = String(body.name || body.brand || body.generic_name || '').trim();
    body.dosage_form = String(body.dosage_form || body.dosageForm || body.category || '').trim();
    body.category = String(body.category || body.dosage_form || 'Medicine').trim();
    body.manufacturer_brand_owner = String(
      body.manufacturer_brand_owner || body.manufacturerBrandOwner || body.manufacturer || ''
    ).trim();
    body.manufacturer = String(body.manufacturer || body.manufacturer_brand_owner || '').trim();

    if (!body.name) {
      return res.status(400).json({
        error: 'Medicine name, brand name, or generic/salt name is required',
        message: 'Medicine name, brand name, or generic/salt name is required'
      });
    }

    const explicitHSN = body.hsn_code !== undefined && body.hsn_code !== null && String(body.hsn_code).trim() !== '';
    const explicitGST = body.gst_rate !== undefined && body.gst_rate !== null && String(body.gst_rate).trim() !== '';

    // The clinical medicine master supplied by hospitals may not contain tax fields.
    // Missing tax metadata is therefore recorded as pending instead of blocking creation.
    if (explicitHSN) {
      if (!validateHSNCode(String(body.hsn_code))) {
        return res.status(400).json({
          error: 'HSN code must be 4-8 digits',
          message: 'HSN code must be 4-8 digits'
        });
      }
      body.hsn_code = String(body.hsn_code).trim().toUpperCase();
    } else {
      delete body.hsn_code;
    }

    if (explicitGST) {
      if (!validateGSTRate(body.gst_rate)) {
        return res.status(400).json({
          error: 'GST rate must be one of: 0, 5, 12, 18, 28',
          message: 'GST rate must be one of: 0, 5, 12, 18, 28'
        });
      }
      body.gst_rate = parseFloat(body.gst_rate);
    } else {
      body.gst_rate = 0;
    }

    body.taxComplianceStatus = explicitHSN && explicitGST ? 'verified' : 'pending';
    body.gst_history = Array.isArray(body.gst_history) ? body.gst_history : [];
    if (explicitHSN || explicitGST) {
      body.gst_history.push({
        hsn_code: body.hsn_code || '',
        gst_rate: body.gst_rate,
        effective_from: new Date(),
        reason: explicitHSN && explicitGST ? 'Initial setup' : 'Partial tax metadata captured',
        changed_by: getUserId(req)
      });
    }

    const sourceHighRisk = body.is_high_risk === true || body.is_high_alert === true ||
      body.highRiskHighAlert === true || body.high_risk_high_alert === true;
    if (sourceHighRisk) {
      body.is_high_risk = true;
      body.is_high_alert = true;
      body.prescription_required = true;
      body.medicationSafety = {
        ...(body.medicationSafety || {}),
        highRisk: true,
        requiresDoubleCheck: true
      };
    }

    const medicine = new Medicine(body);
    await medicine.save();

    return res.status(201).json({
      success: true,
      message: body.taxComplianceStatus === 'pending'
        ? 'Medicine added successfully. Tax metadata is pending verification.'
        : 'Medicine added successfully',
      medicine
    });
  } catch (err) {
    return res.status(400).json({
      error: err.message,
      message: err.message
    });
  }
};

// Get all medicines with stock and tax info
exports.getAllMedicines = async (req, res) => {
  try {
    const filter = medicineScope(req, { is_active: true });
    if (req.query.item_type === 'capex') {
      filter.$or = [{ item_type: 'capex' }, { is_capex: true }, { item_type: { $exists: false } }];
    } else if (req.query.item_type === 'non_capex') {
      filter.$or = [{ item_type: 'non_capex' }, { is_capex: false }];
    }

    const medicines = await Medicine
      .find(filter)
      .sort({ name: 1 });

    const medicinesWithStock = await Promise.all(
      medicines.map(async (medicine) => {
        const medicineObj = medicine.toObject();

        const batches = await MedicineBatch.find({
          medicine_id: medicine._id,
          is_active: true,
          quantity: { $gt: 0 }
        });

        const totalStock = batches.reduce(
          (sum, batch) => sum + (batch.quantity || 0),
          0
        );

        const earliestExpiry = batches.length > 0
          ? batches.reduce(
            (earliest, batch) =>
              batch.expiry_date < earliest ? batch.expiry_date : earliest,
            batches[0].expiry_date
          )
          : null;

        const totalValue = batches.reduce(
          (sum, batch) =>
            sum + ((batch.purchase_price || 0) * (batch.quantity || 0)),
          0
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
    res.status(500).json({
      error: err.message
    });
  }
};

// Get single medicine with stock details and tax info
exports.getMedicineById = async (req, res) => {
  try {
    const medicine = await Medicine.findOne(medicineScope(req, { _id: req.params.id }));

    if (!medicine) {
      return res.status(404).json({
        error: 'Medicine not found'
      });
    }

    const batches = await MedicineBatch
      .find({
        medicine_id: medicine._id,
        is_active: true
      })
      .sort({ expiry_date: 1 })
      .populate('supplier_id', 'name');

    const totalStock = batches.reduce(
      (sum, batch) => sum + (batch.quantity || 0),
      0
    );

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
    res.status(500).json({
      error: err.message
    });
  }
};

// Update medicine with tax validation and history tracking
exports.updateMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOne(medicineScope(req, { _id: req.params.id }));

    if (!medicine) {
      return res.status(404).json({
        error: 'Medicine not found'
      });
    }

    // Track if tax information is being changed
    const taxChanged = (req.body.hsn_code && req.body.hsn_code !== medicine.hsn_code) ||
      (req.body.gst_rate !== undefined && req.body.gst_rate !== medicine.gst_rate);

    // Validate HSN code if provided
    if (req.body.hsn_code !== undefined) {
      if (!validateHSNCode(req.body.hsn_code)) {
        return res.status(400).json({
          error: 'HSN code must be 4-8 digits'
        });
      }

      req.body.hsn_code = req.body.hsn_code.trim().toUpperCase();
    }

    // Validate GST rate if provided
    if (req.body.gst_rate !== undefined) {
      if (!validateGSTRate(req.body.gst_rate)) {
        return res.status(400).json({
          error: 'GST rate must be one of: 0, 5, 12, 18, 28'
        });
      }

      req.body.gst_rate = parseFloat(req.body.gst_rate);
    }

    // Normalize master-data aliases and medication-safety flags for findOneAndUpdate,
    // because Mongoose pre('save') hooks do not run for this operation.
    if (req.body.dosage_form !== undefined && req.body.category === undefined) {
      req.body.category = req.body.dosage_form || medicine.category;
    }
    if (req.body.category !== undefined && req.body.dosage_form === undefined) {
      req.body.dosage_form = req.body.category || medicine.dosage_form;
    }
    if (req.body.manufacturer_brand_owner !== undefined && req.body.manufacturer === undefined) {
      req.body.manufacturer = req.body.manufacturer_brand_owner;
    }
    if (req.body.manufacturer !== undefined && req.body.manufacturer_brand_owner === undefined) {
      req.body.manufacturer_brand_owner = req.body.manufacturer;
    }

    const highRiskWasExplicit = req.body.is_high_risk !== undefined || req.body.is_high_alert !== undefined;
    if (highRiskWasExplicit) {
      const highRisk = Boolean(req.body.is_high_risk || req.body.is_high_alert);
      req.body.is_high_risk = highRisk;
      req.body.is_high_alert = highRisk;
      req.body.prescription_required = highRisk ? true : (req.body.prescription_required ?? medicine.prescription_required);
      req.body.medicationSafety = {
        ...(medicine.medicationSafety?.toObject?.() || medicine.medicationSafety || {}),
        ...(req.body.medicationSafety || {}),
        highRisk,
        requiresDoubleCheck: highRisk
      };
    }

    const effectiveHsn = req.body.hsn_code !== undefined ? req.body.hsn_code : medicine.hsn_code;
    const effectiveGst = req.body.gst_rate !== undefined ? req.body.gst_rate : medicine.gst_rate;
    if (validateHSNCode(effectiveHsn) && validateGSTRate(effectiveGst)) {
      req.body.taxComplianceStatus = 'verified';
    } else if (req.body.hsn_code !== undefined || req.body.gst_rate !== undefined) {
      req.body.taxComplianceStatus = 'pending';
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

    const updatedMedicine = await Medicine.findOneAndUpdate(
      medicineScope(req, { _id: req.params.id }),
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    res.json({
      success: true,
      message: taxChanged
        ? 'Medicine updated. Tax history recorded.'
        : 'Medicine updated.',
      medicine: updatedMedicine
    });
  } catch (err) {
    res.status(400).json({
      error: err.message
    });
  }
};

// Delete medicine (soft delete)
exports.deleteMedicine = async (req, res) => {
  try {
    const medicine = await Medicine.findOneAndUpdate(
      medicineScope(req, { _id: req.params.id }),
      { is_active: false },
      { new: true }
    );

    if (!medicine) {
      return res.status(404).json({
        error: 'Medicine not found'
      });
    }

    res.json({
      message: 'Medicine deactivated successfully'
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
};

// Get expired medicines
exports.getExpiredMedicines = async (req, res) => {
  try {
    const today = new Date();

    const medicineIds = await Medicine.find(medicineScope(req, { is_active: true })).distinct('_id');
    const batches = await MedicineBatch
      .find({
        medicine_id: { $in: medicineIds },
        expiry_date: { $lt: today },
        quantity: { $gt: 0 }
      })
      .populate('medicine_id', 'name generic_name brand dosage_form manufacturer manufacturer_brand_owner hsn_code gst_rate is_high_risk is_high_alert medicationSafety');

    res.json(batches);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
};

// Get low stock medicines
exports.getLowStockMedicines = async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;

    const medicines = await Medicine.aggregate([
      { $match: { hospitalId: hospitalIdFor(req) } },
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
    res.status(500).json({
      error: err.message
    });
  }
};

// Search medicines with tax info
exports.searchMedicines = async (req, res) => {
  try {
    const {
      query,
      q,
      includeBatches = 'true',
      limit = 20
    } = req.query;

    const searchTerm = String(query || q || '').trim();

    if (!searchTerm || searchTerm.length < 2) {
      return res.json([]);
    }

    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = escapedTerm.split(/\s+/).filter(Boolean).join('|');

    const batchMatches = await MedicineBatch
      .find({
        batch_number: { $regex: escapedTerm, $options: 'i' },
        is_active: true
      })
      .select('medicine_id')
      .limit(Number(limit));

    const medicineQuery = {
      hospitalId: hospitalIdFor(req),
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
        ...(batchMatches.length
          ? [{ _id: { $in: batchMatches.map(b => b.medicine_id) } }]
          : [])
      ]
    };

    const medicines = await Medicine
      .find(medicineQuery)
      .limit(Number(limit))
      .select('name generic_name composition compositions brand strength category dosage_form manufacturer manufacturer_brand_owner hsn_code gst_rate taxComplianceStatus base_unit pack_unit units_per_pack allow_loose_sale min_stock_level location prescription_required is_high_risk is_high_alert medicationSafety is_own_brand masterSource')
      .lean();

    if (includeBatches === 'false') {
      return res.json(medicines);
    }

    const medicineIds = medicines.map(m => m._id);

    const batches = await MedicineBatch
      .find({
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

      const stock = medBatches.reduce(
        (sum, batch) => sum + Number(batch.quantity_base_units ?? batch.quantity ?? 0),
        0
      );

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
    res.status(500).json({
      error: err.message
    });
  }
};

// ============== GST / TAX REPORTING ENDPOINTS ==============

// Get medicines by HSN code
exports.getMedicinesByHSN = async (req, res) => {
  try {
    const { hsnCode } = req.params;

    const medicines = await Medicine
      .find({
        hospitalId: hospitalIdFor(req),
        hsn_code: { $regex: new RegExp(`^${hsnCode}$`, 'i') },
        is_active: true
      })
      .select('name brand hsn_code gst_rate composition category');

    res.json({
      success: true,
      count: medicines.length,
      medicines,
      hsn_code: hsnCode
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
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
      { $match: { hospitalId: hospitalIdFor(req) } },
      { $match: matchStage },
      {
        $match: {
          hsn_code: { $type: 'string', $nin: ['', null] }
        }
      },
      {
        $group: {
          _id: {
            hsn_code: '$hsn_code',
            gst_rate: '$gst_rate'
          },
          hsn_code: { $first: '$hsn_code' },
          gst_rate: { $first: '$gst_rate' },
          medicine_count: { $sum: 1 },
          medicines: {
            $push: {
              name: '$name',
              brand: '$brand',
              composition: '$composition'
            }
          }
        }
      },
      { $sort: { hsn_code: 1 } }
    ]);

    // Calculate GST rate distribution
    const rateDistribution = await Medicine.aggregate([
      { $match: { hospitalId: hospitalIdFor(req) } },
      { $match: matchStage },
      {
        $group: {
          _id: '$gst_rate',
          rate: { $first: '$gst_rate' },
          count: { $sum: 1 },
          medicines: {
            $push: {
              name: '$name',
              hsn_code: '$hsn_code'
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Get medicines without HSN (non-compliant)
    const scopedMatch = { hospitalId: hospitalIdFor(req), ...matchStage };
    const missingHSN = await Medicine.countDocuments({
      ...scopedMatch,
      $or: [
        { hsn_code: null },
        { hsn_code: '' },
        { hsn_code: { $exists: false } }
      ]
    });

    // Get medicines with invalid or unverified GST rates within this hospital.
    const invalidGST = await Medicine.countDocuments({
      ...scopedMatch,
      $or: [
        { gst_rate: { $nin: [0, 5, 12, 18, 28] } },
        { taxComplianceStatus: 'pending' }
      ]
    });

    res.json({
      success: true,
      summary: {
        total_medicines: await Medicine.countDocuments(scopedMatch),
        total_medicines_with_gst: gstSummary.reduce((sum, item) => sum + item.medicine_count, 0),
        unique_hsn_codes: gstSummary.length,
        medicines_missing_hsn: missingHSN,
        medicines_with_invalid_gst: invalidGST,
        gst_rate_distribution: rateDistribution.map(r => ({
          rate: r.rate,
          count: r.count
        }))
      },
      by_hsn: gstSummary,
      by_rate: rateDistribution
    });
  } catch (err) {
    console.error('Error getting GST summary:', err);
    res.status(500).json({
      error: err.message
    });
  }
};

// Bulk update GST rates for medicines (with history tracking)
exports.bulkUpdateGST = async (req, res) => {
  try {
    const { updates, reason } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({
        error: 'Updates array is required'
      });
    }

    const results = [];
    const errors = [];
    const userId = getUserId(req);

    for (const update of updates) {
      try {
        const { medicineId, hsn_code, gst_rate } = update;

        if (!medicineId) {
          errors.push({
            medicineId,
            error: 'Medicine ID is required'
          });
          continue;
        }

        const medicine = await Medicine.findOne(medicineScope(req, { _id: medicineId }));

        if (!medicine) {
          errors.push({
            medicineId,
            error: 'Medicine not found'
          });
          continue;
        }

        const updateData = {};

        // Validate and set HSN
        if (hsn_code !== undefined) {
          if (!validateHSNCode(hsn_code)) {
            errors.push({
              medicineId,
              error: 'HSN code must be 4-8 digits'
            });
            continue;
          }

          updateData.hsn_code = hsn_code.trim().toUpperCase();
        }

        // Validate and set GST rate
        if (gst_rate !== undefined) {
          if (!validateGSTRate(gst_rate)) {
            errors.push({
              medicineId,
              error: 'GST rate must be one of: 0, 5, 12, 18, 28'
            });
            continue;
          }

          updateData.gst_rate = parseFloat(gst_rate);
        }

        const effectiveHsn = updateData.hsn_code !== undefined ? updateData.hsn_code : medicine.hsn_code;
        const effectiveGst = updateData.gst_rate !== undefined ? updateData.gst_rate : medicine.gst_rate;
        updateData.taxComplianceStatus = validateHSNCode(effectiveHsn) && validateGSTRate(effectiveGst)
          ? 'verified'
          : 'pending';

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

        const updatedMedicine = await Medicine.findOneAndUpdate(
          medicineScope(req, { _id: medicineId }),
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
        errors.push({
          medicineId: update.medicineId,
          error: err.message
        });
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
    res.status(500).json({
      error: err.message
    });
  }
};

// Export GST data to CSV
exports.exportGSTData = async (req, res) => {
  try {
    const medicines = await Medicine
      .find(medicineScope(req, { is_active: true }))
      .select('name generic_name brand dosage_form hsn_code gst_rate taxComplianceStatus composition category manufacturer manufacturer_brand_owner is_high_risk is_high_alert')
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
    res.status(500).json({
      error: err.message
    });
  }
};

// Get tax history for a medicine (audit trail)
exports.getMedicineTaxHistory = async (req, res) => {
  try {
    const { id } = req.params;

    const medicine = await Medicine.findOne(medicineScope(req, { _id: id }))
      .select('name hsn_code gst_rate gst_history');

    if (!medicine) {
      return res.status(404).json({
        error: 'Medicine not found'
      });
    }

    // Get batches with their tax snapshots
    const batches = await MedicineBatch
      .find({
        medicine_id: id,
        is_active: true
      })
      .select('batch_number tax_snapshot purchase_date received_date');

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
    res.status(500).json({
      error: err.message
    });
  }
};

// Get GST compliant medicines (for reporting)
exports.getGSTCompliantMedicines = async (req, res) => {
  try {
    const hospitalId = hospitalIdFor(req);
    const compliant = await Medicine.countDocuments({
      hospitalId,
      is_active: true,
      hsn_code: { $type: 'string', $nin: ['', null] },
      gst_rate: { $in: [0, 5, 12, 18, 28] },
      taxComplianceStatus: { $ne: 'pending' }
    });

    const nonCompliant = await Medicine.countDocuments({
      hospitalId,
      is_active: true,
      $or: [
        { hsn_code: null },
        { hsn_code: '' },
        { hsn_code: { $exists: false } },
        { gst_rate: { $nin: [0, 5, 12, 18, 28] } },
        { taxComplianceStatus: 'pending' }
      ]
    });

    const total = compliant + nonCompliant;

    res.json({
      success: true,
      compliant_count: compliant,
      non_compliant_count: nonCompliant,
      total_active: total,
      compliance_percentage: total > 0
        ? ((compliant / total) * 100).toFixed(2)
        : '0.00'
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
};

exports.getFormulary = async (req, res) => {
  try {
    const hid = hospitalIdFor(req);
    const search = String(req.query.search || '').trim();

    const filter = {
      hospitalId: hid,
      is_active: true,
      'medicationSafety.formularyStatus': {
        $in: ['formulary', 'restricted']
      }
    };

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { name: rx },
        { generic_name: rx },
        { brand: rx }
      ];
    }

    const meds = await Medicine
      .find(filter)
      .sort({ name: 1 })
      .lean();

    const data = await Promise.all(meds.map(async (m) => {
      const batches = await MedicineBatch
        .find({
          medicine_id: m._id,
          is_active: true,
          quantity: { $gt: 0 }
        })
        .select('quantity expiry_date')
        .lean();

      return {
        ...m,
        stock_quantity: batches.reduce((s, b) => s + Number(b.quantity || 0), 0),
        earliest_expiry: batches.length
          ? batches.map(b => b.expiry_date).filter(Boolean).sort()[0]
          : null
      };
    }));

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
};

exports.getEmergencyStock = async (req, res) => {
  try {
    const medicines = await Medicine
      .find({
        hospitalId: hospitalIdFor(req),
        is_active: true,
        'medicationSafety.emergencyMedicine': true
      })
      .lean();

    const data = await Promise.all(medicines.map(async (m) => {
      const batches = await MedicineBatch
        .find({
          medicine_id: m._id,
          is_active: true,
          quantity: { $gt: 0 }
        })
        .lean();

      return {
        ...m,
        stock_quantity: batches.reduce((s, b) => s + Number(b.quantity || 0), 0),
        batches
      };
    }));

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message
    });
  }
};

exports.createEmergencyChecklist = async (req, res) => {
  try {
    if (!req.body.location || !Array.isArray(req.body.items) || !req.body.items.length) {
      return res.status(400).json({
        error: 'location and at least one checklist item are required'
      });
    }

    const items = [];

    for (const raw of req.body.items) {
      let medicine = null;

      if (raw.medicineId) {
        if (!mongoose.isValidObjectId(raw.medicineId)) {
          return res.status(400).json({
            error: 'Invalid medicineId in emergency checklist'
          });
        }

        medicine = await Medicine.findOne({
          _id: raw.medicineId,
          hospitalId: hospitalIdFor(req)
        });

        if (!medicine) {
          return res.status(404).json({
            error: 'Emergency checklist medicine not found'
          });
        }
      }

      const key = String(raw.key || (medicine ? `medicine:${medicine._id}` : '')).trim();
      const label = String(raw.label || medicine?.name || medicine?.medicine_name || '').trim();

      if (!key || !label) {
        return res.status(400).json({
          error: 'Each emergency checklist item requires key/label or a valid medicineId'
        });
      }

      const complete = raw.complete !== undefined
        ? Boolean(raw.complete)
        : Boolean(raw.available === true && raw.expiryChecked === true);

      items.push({
        key,
        label,
        medicineId: medicine?._id,
        available: raw.available,
        quantity: raw.quantity,
        expiryChecked: raw.expiryChecked,
        complete,
        note: raw.note
      });
    }

    const complete = items.every((x) => x.complete === true);

    const row = await EmergencyMedicationChecklist.create({
      hospitalId: hospitalIdFor(req),
      location: req.body.location,
      checklistDate: req.body.checklistDate || new Date(),
      items,
      status: complete ? 'completed' : 'draft',
      completedBy: complete ? req.user._id : undefined,
      completedAt: complete ? (req.body.completedAt || new Date()) : undefined
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    const status = e?.name === 'ValidationError' || e?.name === 'CastError' ? 400 : 500;
    return res.status(status).json({
      error: e.message
    });
  }
};

exports.listEmergencyChecklists = async (req, res) => {
  const f = {
    hospitalId: hospitalIdFor(req)
  };

  if (req.query.location) {
    f.location = req.query.location;
  }

  const data = await EmergencyMedicationChecklist
    .find(f)
    .sort({ checklistDate: -1 })
    .limit(100)
    .lean();

  return res.json({
    success: true,
    data
  });
};

// Get all distinct categories across active medicines & items
exports.getCategories = async (req, res) => {
  try {
    const rawCategories = await Medicine.distinct('category', medicineScope(req, { is_active: true }));
    const cleanCategories = Array.from(
      new Set(rawCategories.filter(Boolean).map(c => String(c).trim()))
    ).sort((a, b) => a.localeCompare(b));

    return res.json({
      success: true,
      categories: cleanCategories
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};