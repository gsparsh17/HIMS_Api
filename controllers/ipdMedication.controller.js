const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDCharge = require('../models/IPDCharge');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Pharmacy = require('../models/Pharmacy');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const { parseDoseQty, calculateRequiredBaseUnits } = require('../services/pharmacyTransaction.service');

// ========== HELPER FUNCTIONS ==========

// Helper function to generate timing slots
function generateTimingSlots(frequency, durationDays) {
  const timingSlots = [];
  const freqTimingMap = {
    'OD': ['08:00'],
    'BD': ['08:00', '20:00'],
    'TDS': ['08:00', '14:00', '20:00'],
    'QDS': ['06:00', '12:00', '18:00', '22:00'],
    'q4h': ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'],
    'q6h': ['06:00', '12:00', '18:00', '00:00'],
    'q8h': ['06:00', '14:00', '22:00'],
    'q12h': ['08:00', '20:00'],
    'Stat': ['now'],
    'SOS': []
  };

  const times = freqTimingMap[frequency] || ['08:00'];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 0; d < durationDays; d++) {
    const slotDate = new Date(today);
    slotDate.setDate(today.getDate() + d);

    for (const t of times) {
      timingSlots.push({
        date: slotDate,
        time: t,
        status: 'Pending'
      });
    }
  }

  return timingSlots;
}

// Helper function to create pharmacy request
async function createPharmacyRequest(medication) {
  try {
    const pharmacy = await Pharmacy.findOne({ status: 'Active' });
    if (!pharmacy) {
      console.log('No active pharmacy found for medication request');
      return;
    }

    const requestNumber = `PHARM-REQ-${Date.now()}-${medication._id}`;

    medication.pharmacyRequest = {
      requestedToPharmacy: true,
      requestedAt: new Date(),
      requestedBy: medication.createdBy,
      pharmacyId: pharmacy._id,
      pharmacyRequestNumber: requestNumber,
      pharmacyStatus: 'Pending'
    };

    medication.status = 'Requested';
    await medication.save();

  } catch (error) {
    console.error('Error creating pharmacy request:', error);
  }
}

// Helper function to get or create patient medicine stock
async function getOrCreatePatientMedicineStock(admissionId, patientId, medicineId, batchId, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit) {
  let stock = await IPDPatientMedicineStock.findOne({
    admissionId,
    patientId,
    medicineId,
    batchId
  });

  if (!stock) {
    stock = new IPDPatientMedicineStock({
      admissionId,
      patientId,
      medicineId,
      batchId,
      medicineName,
      baseUnit: baseUnit || 'unit',
      packUnit: packUnit || 'pack',
      unitsPerPack: unitsPerPack || 1,
      issuedQtyBaseUnits: 0,
      administeredQtyBaseUnits: 0,
      returnedQtyBaseUnits: 0,
      currentBalanceBaseUnits: 0,
      sourceSaleIds: [],
      medicationChartIds: []
    });
    await stock.save();
  }

  return stock;
}

// Helper function to update patient medicine stock when pharmacy issues medicine
async function addToPatientMedicineStock(admissionId, patientId, medicineId, batchId, quantityBaseUnits, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit, saleId, medicationChartId) {
  const stock = await getOrCreatePatientMedicineStock(
    admissionId, patientId, medicineId, batchId, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit
  );

  stock.issuedQtyBaseUnits += quantityBaseUnits;
  stock.currentBalanceBaseUnits += quantityBaseUnits;

  if (saleId && !stock.sourceSaleIds.includes(saleId)) {
    stock.sourceSaleIds.push(saleId);
  }

  if (medicationChartId && !stock.medicationChartIds.includes(medicationChartId)) {
    stock.medicationChartIds.push(medicationChartId);
  }

  stock.lastIssuedAt = new Date();
  await stock.save();

  return stock;
}

// Helper function to deduct from patient medicine stock when nurse administers
async function deductFromPatientMedicineStock(admissionId, patientId, medicineId, quantityBaseUnits, medicationChartId) {
  const stocks = await IPDPatientMedicineStock.find({
    admissionId,
    patientId,
    medicineId,
    currentBalanceBaseUnits: { $gte: quantityBaseUnits }
  }).sort({ createdAt: 1 });

  let remainingToDeduct = quantityBaseUnits;
  let deducted = false;

  for (const stock of stocks) {
    if (remainingToDeduct <= 0) break;

    const deductAmount = Math.min(stock.currentBalanceBaseUnits, remainingToDeduct);
    stock.administeredQtyBaseUnits += deductAmount;
    stock.currentBalanceBaseUnits -= deductAmount;
    remainingToDeduct -= deductAmount;

    if (medicationChartId && !stock.medicationChartIds.includes(medicationChartId)) {
      stock.medicationChartIds.push(medicationChartId);
    }

    stock.lastAdministeredAt = new Date();
    await stock.save();
    deducted = true;
  }

  return deducted;
}

// ========== MEDICATION CHART ==========

// Create medication order (from Doctor Round)
exports.createMedicationOrder = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      prescribedBy,
      roundId,
      prescriptionId,
      medicineId,
      medicineName,
      genericName,
      route,
      dosage,
      frequency,
      startDate,
      endDate,
      duration,
      durationUnit,
      specialInstructions,
      isHighRisk,
      requiresDoubleVerification,
      requiresPharmacyDispense
    } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    let costPerUnit = 0;
    let medicineDetails = null;
    let baseUnit = 'unit';
    let packUnit = 'pack';
    let unitsPerPack = 1;

    if (medicineId) {
      medicineDetails = await Medicine.findById(medicineId);
      if (medicineDetails) {
        costPerUnit = medicineDetails.selling_price || medicineDetails.mrp || 0;
        baseUnit = medicineDetails.base_unit || 'unit';
        packUnit = medicineDetails.pack_unit || 'pack';
        unitsPerPack = medicineDetails.units_per_pack || 1;
      }
    }

    const requiredQtyBaseUnits = calculateRequiredBaseUnits({
      dosage,
      frequency,
      duration: duration || 1,
      durationUnit: durationUnit || 'Days'
    });

    const medication = new IPDMedicationChart({
      admissionId,
      patientId,
      prescribedBy,
      roundId: roundId || null,
      prescriptionId: prescriptionId || null,
      medicineId: medicineId || null,
      medicineName,
      genericName,
      route,
      dosage,
      frequency,
      startDate: startDate || new Date(),
      endDate,
      duration: duration || 1,
      durationUnit,
      specialInstructions,
      isHighRisk: isHighRisk || false,
      requiresDoubleVerification: requiresDoubleVerification || false,
      requiresPharmacyDispense: requiresPharmacyDispense || false,
      costPerUnit,
      requiredQtyBaseUnits,
      requiredQtyBaseUnits,
      status: 'Active',
      createdBy: req.user?._id
    });

    const timingSlots = generateTimingSlots(frequency, duration || 1);
    medication.timing = timingSlots;

    await medication.save();

    const nursingNote = new NursingNote({
      admissionId,
      patientId,
      noteType: 'Medication',
      note: `New medication ordered: ${medicineName} ${dosage} ${route} ${frequency}`,
      priority: isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.status(201).json({
      success: true,
      message: 'Medication order created successfully',
      medication
    });
  } catch (err) {
    console.error('Error creating medication order:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getMedicationsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { status } = req.query;

    const filter = { admissionId };
    if (status) filter.status = status;

    const medications = await IPDMedicationChart.find(filter)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name selling_price mrp base_unit pack_unit units_per_pack')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .sort({ startDate: -1 });

    // Get patient medicine stock for this admission
    const patientStocks = await IPDPatientMedicineStock.find({ admissionId }).populate('medicineId', 'name strength');

    // Helper function to normalize medicine name for comparison
    const normalizeMedicineName = (name) => {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*mg\s*/g, '')
        .replace(/\s*ml\s*/g, '')
        .replace(/\s*g\s*/g, '')
        .trim();
    };

    // Create maps for stock lookup
    const stockByIdMap = {};
    const stockByNameMap = {};
    const stockByNormalizedNameMap = {};

    patientStocks.forEach(stock => {
      const medicineId = stock.medicineId?._id?.toString();
      const medicineName = stock.medicineName || stock.medicineId?.name;
      const normalizedName = normalizeMedicineName(medicineName);

      if (medicineId) {
        stockByIdMap[medicineId] = {
          currentBalance: stock.currentBalanceBaseUnits,
          issuedQty: stock.issuedQtyBaseUnits,
          administeredQty: stock.administeredQtyBaseUnits,
          returnedQty: stock.returnedQtyBaseUnits,
          baseUnit: stock.baseUnit || 'unit',
          stockId: stock._id,
          medicineName: medicineName,
          normalizedName: normalizedName
        };
      }

      if (medicineName) {
        stockByNameMap[medicineName] = {
          currentBalance: stock.currentBalanceBaseUnits,
          issuedQty: stock.issuedQtyBaseUnits,
          administeredQty: stock.administeredQtyBaseUnits,
          returnedQty: stock.returnedQtyBaseUnits,
          baseUnit: stock.baseUnit || 'unit',
          stockId: stock._id,
          medicineName: medicineName
        };

        stockByNormalizedNameMap[normalizedName] = {
          currentBalance: stock.currentBalanceBaseUnits,
          issuedQty: stock.issuedQtyBaseUnits,
          administeredQty: stock.administeredQtyBaseUnits,
          returnedQty: stock.returnedQtyBaseUnits,
          baseUnit: stock.baseUnit || 'unit',
          stockId: stock._id,
          medicineName: medicineName
        };
      }
    });

    // Add stock information to each medication
    const medicationsWithStock = medications.map(med => {
      const medicineId = med.medicineId?._id?.toString();
      const medicineName = med.medicineName;
      const normalizedMedName = normalizeMedicineName(medicineName);

      // Find stock info
      let stockInfo = null;

      if (medicineId && stockByIdMap[medicineId]) {
        stockInfo = stockByIdMap[medicineId];
      } else if (medicineName && stockByNameMap[medicineName]) {
        stockInfo = stockByNameMap[medicineName];
      } else if (normalizedMedName && stockByNormalizedNameMap[normalizedMedName]) {
        stockInfo = stockByNormalizedNameMap[normalizedMedName];
      } else if (medicineName) {
        for (const [stockMedName, stock] of Object.entries(stockByNameMap)) {
          const normalizedStockName = normalizeMedicineName(stockMedName);
          if (normalizedStockName.includes(normalizedMedName) || normalizedMedName.includes(normalizedStockName)) {
            stockInfo = stock;
            break;
          }
        }
      }

      const finalStockInfo = stockInfo || {
        currentBalance: 0,
        issuedQty: 0,
        administeredQty: 0,
        returnedQty: 0,
        baseUnit: med.medicineId?.base_unit || 'unit'
      };

      // Calculate required stock for today's pending doses
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todaysPendingDoses = (med.timing || []).filter(t => {
        const tDate = t.date ? new Date(t.date) : new Date(t.time);
        return !isNaN(tDate.getTime()) && tDate.toDateString() === today.toDateString() && t.status === 'Pending';
      }).length;

      // Calculate required stock = number of pending doses (each dose = 1 base unit)
      const requiredStockForToday = todaysPendingDoses;

      return {
        ...med.toObject(),
        stockInfo: finalStockInfo,
        todaysPendingDoses,
        requiredStockForToday,
        isStockSufficient: finalStockInfo.currentBalance >= requiredStockForToday,
        stockStatus: finalStockInfo.currentBalance === 0 ? 'No Stock' :
          finalStockInfo.currentBalance < requiredStockForToday ? 'Low Stock' : 'Sufficient'
      };
    });

    res.json({ success: true, medications: medicationsWithStock });
  } catch (err) {
    console.error('Error fetching medications:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication by ID
exports.getMedicationById = async (req, res) => {
  try {
    const { id } = req.params;
    const medication = await IPDMedicationChart.findById(id)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name selling_price mrp base_unit pack_unit units_per_pack')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .populate('pharmacyRequest.dispensedBatchId', 'batch_number expiry_date');

    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const patientStock = await IPDPatientMedicineStock.findOne({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      medicineId: medication.medicineId
    });

    res.json({
      success: true,
      medication,
      patientStockBalance: patientStock?.currentBalanceBaseUnits || 0
    });
  } catch (err) {
    console.error('Error fetching medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== PHARMACY INTEGRATION ==========

// Pharmacy: Get pending medication requests
exports.getPendingPharmacyRequests = async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    const medications = await IPDMedicationChart.find({
      'pharmacyRequest.requestedToPharmacy': true,
      'pharmacyRequest.pharmacyId': pharmacyId,
      'pharmacyRequest.pharmacyStatus': 'Pending'
    })
      .populate('admissionId', 'admissionNumber')
      .populate('patientId', 'first_name last_name patientId')
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name base_unit pack_unit units_per_pack');

    res.json({ success: true, requests: medications });
  } catch (err) {
    console.error('Error fetching pharmacy requests:', err);
    res.status(500).json({ error: err.message });
  }
};

// Pharmacy: Process medication request (Approve/Reject)
exports.processPharmacyRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, batchId, dispensedQuantity, notes } = req.body;

    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    if (action === 'approve') {
      if (batchId) {
        const batch = await MedicineBatch.findById(batchId);
        if (!batch) {
          return res.status(404).json({ error: 'Batch not found' });
        }

        const dispenseQty = dispensedQuantity || medication.pharmacyRequest?.requestedQuantity || medication.requiredQtyBaseUnits || 1;

        if (batch.quantity_base_units < dispenseQty) {
          return res.status(400).json({ error: 'Insufficient stock in batch' });
        }

        batch.quantity_base_units -= dispenseQty;
        batch.quantity = batch.quantity_base_units;
        await batch.save();

        if (medication.medicineId) {
          await Medicine.findByIdAndUpdate(
            medication.medicineId._id,
            { $inc: { stock_quantity: -dispenseQty } }
          );
        }

        await addToPatientMedicineStock(
          medication.admissionId,
          medication.patientId,
          medication.medicineId?._id || null,
          batchId,
          dispenseQty,
          medication.medicineName,
          medication.medicineId?.base_unit || 'unit',
          medication.medicineId?.pack_unit || 'pack',
          medication.medicineId?.units_per_pack || 1,
          batch.selling_price_per_base_unit || 0,
          null,
          medication._id
        );

        medication.pharmacyRequest.dispensedBatchId = batchId;
        medication.pharmacyRequest.dispensedQuantity = dispenseQty;
        medication.pharmacyRequest.dispensedAt = new Date();
        medication.pharmacyRequest.dispensedFromPharmacy = true;

        const timingSlots = generateTimingSlots(medication.frequency, medication.duration || 1);
        medication.timing = timingSlots;
      }

      medication.pharmacyRequest.pharmacyStatus = 'Approved';
      medication.status = 'Active';

    } else if (action === 'reject') {
      medication.pharmacyRequest.pharmacyStatus = 'Rejected';
      medication.status = 'Stopped';
      medication.stoppedReason = `Pharmacy rejected: ${notes || 'Stock not available'}`;

    } else if (action === 'out_of_stock') {
      medication.pharmacyRequest.pharmacyStatus = 'OutOfStock';
      medication.pharmacyRequest.pharmacyNotes = notes;
    }

    if (notes) {
      medication.pharmacyRequest.pharmacyNotes = notes;
    }

    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      noteType: 'Medication',
      note: `Pharmacy ${action}ed medication: ${medication.medicineName}. ${notes || ''}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: `Pharmacy request ${action}d successfully`,
      medication
    });
  } catch (err) {
    console.error('Error processing pharmacy request:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== MEDICATION ADMINISTRATION (NURSE) ==========

// Nurse: Request medication from pharmacy
exports.requestPharmacy = async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const pharmacy = await Pharmacy.findOne({ status: 'Active' });
    if (!pharmacy) {
      return res.status(400).json({ error: 'No active pharmacy found to handle request.' });
    }

    const requestNumber = `PHARM-REQ-${Date.now()}-${medication._id.toString().substring(0, 6)}`;

    medication.pharmacyRequest = {
      requestedToPharmacy: true,
      requestedAt: new Date(),
      requestedBy: req.user?._id,
      pharmacyId: pharmacy._id,
      pharmacyRequestNumber: requestNumber,
      pharmacyStatus: 'Pending',
      requestedQuantity: quantity || medication.requiredQtyBaseUnits || 1
    };

    await medication.save();

    res.json({
      success: true,
      message: 'Medication requested from pharmacy successfully',
      medication
    });
  } catch (err) {
    console.error('Error requesting pharmacy:', err);
    res.status(500).json({ error: err.message });
  }
};


// Get today's medication schedule for nurse
exports.getNurseTodaySchedule = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const admissions = await IPDAdmission.find({
      status: { $in: ['Admitted', 'Under Treatment'] }
    }).select('_id');

    const admissionIds = admissions.map(a => a._id);

    const medications = await IPDMedicationChart.find({
      admissionId: { $in: admissionIds },
      status: 'Active',
      startDate: { $lte: tomorrow }
    })
      .populate('admissionId', 'admissionNumber bedId')
      .populate('patientId', 'first_name last_name patientId')
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name');

    const todaySchedule = medications.map(med => {
      const todaysTimings = (med.timing || []).filter(t => {
        const timingDate = new Date(t.date);
        timingDate.setHours(0, 0, 0, 0);
        return timingDate.getTime() === today.getTime() && t.status === 'Pending';
      });

      return {
        ...med.toObject(),
        todaysTimings,
        pendingCount: todaysTimings.length
      };
    }).filter(med => med.todaysTimings.length > 0);

    res.json({ success: true, schedule: todaySchedule });
  } catch (err) {
    console.error('Error fetching nurse schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication schedule for specific admission (nurse view)
exports.getMedicationScheduleForNurse = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { date } = req.query;

    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
    }
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const medications = await IPDMedicationChart.find({
      admissionId,
      status: 'Active',
      startDate: { $lte: nextDate }
    })
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name base_unit pack_unit units_per_pack');

    const schedule = await Promise.all(medications.map(async (med) => {
      const todaysTimings = (med.timing || []).filter(t => {
        const timingDate = new Date(t.date);
        timingDate.setHours(0, 0, 0, 0);
        return timingDate.getTime() === targetDate.getTime();
      });

      let patientStockBalance = 0;
      if (med.medicineId) {
        const stock = await IPDPatientMedicineStock.findOne({
          admissionId,
          patientId: med.patientId,
          medicineId: med.medicineId._id
        });
        patientStockBalance = stock?.currentBalanceBaseUnits || 0;
      }

      return {
        ...med.toObject(),
        todaysTimings,
        administeredCount: todaysTimings.filter(t => t.status === 'Administered').length,
        pendingCount: todaysTimings.filter(t => t.status === 'Pending').length,
        patientStockBalance,
        requiredStockForDay: todaysTimings.length
      };
    })).filter(med => med.todaysTimings.length > 0);

    res.json({ success: true, schedule, date: targetDate });
  } catch (err) {
    console.error('Error fetching medication schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// Administer medication (Nurse action)
exports.administerMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks, witnessedBy } = req.body;

    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const timingIndex = medication.timing.findIndex(t => t._id.toString() === timingId);
    if (timingIndex === -1) {
      return res.status(404).json({ error: 'Timing not found' });
    }

    if (medication.isHighRisk && medication.requiresDoubleVerification && !witnessedBy) {
      return res.status(400).json({ error: 'Double verification required for high-risk medication' });
    }

    const doseQtyBaseUnits = Math.max(1, Math.ceil(parseDoseQty(medication.dosage)));

    let stock = null;
    if (medication.medicineId) {
      stock = await IPDPatientMedicineStock.findOne({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medication.medicineId._id,
        currentBalanceBaseUnits: { $gte: doseQtyBaseUnits }
      });

      if (!stock) {
        return res.status(400).json({
          error: `Insufficient patient medicine stock for ${medication.medicineName}. Required: ${doseQtyBaseUnits}`
        });
      }

      stock.administeredQtyBaseUnits += doseQtyBaseUnits;
      stock.currentBalanceBaseUnits -= doseQtyBaseUnits;
      stock.lastAdministeredAt = new Date();
      await stock.save();
    }

    medication.timing[timingIndex].status = 'Administered';
    medication.timing[timingIndex].administeredAt = new Date();
    medication.timing[timingIndex].administeredBy = req.user?._id;
    medication.timing[timingIndex].remarks = remarks;

    if (witnessedBy) {
      medication.timing[timingIndex].witnessedBy = witnessedBy;
    }

    const allCompleted = medication.timing.every(t =>
      t.status === 'Administered' || t.status === 'Skipped' || t.status === 'Held'
    );

    if (allCompleted) {
      medication.status = 'Completed';
    }

    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id || req.user?.id,
      noteType: 'Medication',
      note: `Medication administered: ${medication.medicineName} ${medication.dosage}. ${remarks || ''}`,
      priority: medication.isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id || req.user?.id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication administered successfully',
      medication,
      remainingStock: stock?.currentBalanceBaseUnits || 0
    });
  } catch (err) {
    console.error('Error administering medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Skip medication (Nurse action)
exports.skipMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const timingIndex = medication.timing.findIndex(t => t._id.toString() === timingId);
    if (timingIndex === -1) {
      return res.status(404).json({ error: 'Timing not found' });
    }

    medication.timing[timingIndex].status = 'Skipped';
    medication.timing[timingIndex].remarks = remarks;
    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id || req.user?.id,
      noteType: 'Medication',
      note: `Medication skipped: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`,
      priority: 'Normal',
      createdBy: req.user?._id || req.user?.id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication skipped',
      medication
    });
  } catch (err) {
    console.error('Error skipping medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Hold medication (Nurse action)
exports.holdMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const timingIndex = medication.timing.findIndex(t => t._id.toString() === timingId);
    if (timingIndex === -1) {
      return res.status(404).json({ error: 'Timing not found' });
    }

    medication.timing[timingIndex].status = 'Held';
    medication.timing[timingIndex].remarks = remarks;
    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id || req.user?.id,
      noteType: 'Medication',
      note: `Medication held: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`,
      priority: 'Important',
      createdBy: req.user?._id || req.user?.id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication held',
      medication
    });
  } catch (err) {
    console.error('Error holding medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Stop medication order (Doctor action)
exports.stopMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { stoppedReason } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    medication.status = 'Stopped';
    medication.stoppedReason = stoppedReason;
    medication.stoppedBy = req.user?._id;
    medication.endDate = new Date();
    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      noteType: 'Medication',
      note: `Medication stopped: ${medication.medicineName}. Reason: ${stoppedReason}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication stopped successfully',
      medication
    });
  } catch (err) {
    console.error('Error stopping medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication schedule for today (admission specific)
exports.getTodaySchedule = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const medications = await IPDMedicationChart.find({
      admissionId,
      status: 'Active',
      startDate: { $lte: tomorrow }
    }).populate('prescribedBy', 'firstName lastName');

    const todaySchedule = await Promise.all(medications.map(async (med) => ({
      ...med.toObject(),
      todaysTimings: (med.timing || []).filter(t => {
        const timingDate = new Date(t.date);
        timingDate.setHours(0, 0, 0, 0);
        return timingDate.getTime() === today.getTime();
      })
    })));

    res.json({ success: true, schedule: todaySchedule.filter(med => med.todaysTimings.length > 0) });
  } catch (err) {
    console.error('Error fetching today\'s schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication administration summary for admission
exports.getMedicationSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const medications = await IPDMedicationChart.find({ admissionId });

    const summary = {
      total: medications.length,
      active: medications.filter(m => m.status === 'Active').length,
      completed: medications.filter(m => m.status === 'Completed').length,
      stopped: medications.filter(m => m.status === 'Stopped').length,
      pendingPharmacy: medications.filter(m => m.pharmacyRequest?.pharmacyStatus === 'Pending').length,
      totalDosesAdministered: 0,
      totalDosesSkipped: 0,
      totalDosesHeld: 0,
      totalCost: 0
    };

    medications.forEach(med => {
      summary.totalDosesAdministered += (med.timing || []).filter(t => t.status === 'Administered').length;
      summary.totalDosesSkipped += (med.timing || []).filter(t => t.status === 'Skipped').length;
      summary.totalDosesHeld += (med.timing || []).filter(t => t.status === 'Held').length;
      summary.totalCost += med.totalCost || 0;
    });

    const patientStocks = await IPDPatientMedicineStock.find({ admissionId });
    const stockSummary = {
      totalMedicinesIssued: patientStocks.length,
      totalUnitsIssued: patientStocks.reduce((sum, s) => sum + s.issuedQtyBaseUnits, 0),
      totalUnitsAdministered: patientStocks.reduce((sum, s) => sum + s.administeredQtyBaseUnits, 0),
      totalUnitsReturned: patientStocks.reduce((sum, s) => sum + s.returnedQtyBaseUnits, 0),
      currentBalance: patientStocks.reduce((sum, s) => sum + s.currentBalanceBaseUnits, 0)
    };

    res.json({ success: true, summary, stockSummary });
  } catch (err) {
    console.error('Error fetching medication summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// Receive medicine stock from an external pharmacy directly
exports.receiveExternalPharmacyStock = async (req, res) => {
  try {
    const { id } = req.params; // Medication ID
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }

    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    if (!medication.medicineId) {
       return res.status(400).json({ error: 'External stock receiving requires a mapped medicine in the system' });
    }

    // Get or Create Stock for this patient and medicine
    await getOrCreatePatientMedicineStock(
      medication.admissionId,
      medication.patientId,
      medication.medicineId._id,
      null, // batchId
      medication.medicineName,
      medication.medicineId.base_unit || 'unit',
      medication.medicineId.pack_unit || 'pack',
      medication.medicineId.units_per_pack || 1,
      0 // External price, not tracked internally for revenue usually
    );

    // Add stock directly (simulate it being issued by an external pharmacy)
    await addToPatientMedicineStock(
      medication.admissionId,
      medication.patientId,
      medication.medicineId._id,
      null, // batchId
      quantity, // base units
      medication.medicineName,
      medication.medicineId.base_unit || 'unit',
      medication.medicineId.pack_unit || 'pack',
      medication.medicineId.units_per_pack || 1,
      0, // cost 
      null, // saleId
      medication._id
    );

    // Ensure status is active in case it was pending
    medication.status = 'Active';
    await medication.save();

    res.json({
      success: true,
      message: `Successfully received ${quantity} units from external pharmacy`,
      medication
    });
  } catch (err) {
    console.error('Error receiving external pharmacy stock:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get patient medicine stock
exports.getPatientMedicineStock = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const stocks = await IPDPatientMedicineStock.find({ admissionId })
      .populate('medicineId', 'name base_unit pack_unit units_per_pack')
      .populate('batchId', 'batch_number expiry_date')
      .sort({ createdAt: -1 });

    res.json({ success: true, stocks });
  } catch (err) {
    console.error('Error fetching patient medicine stock:', err);
    res.status(500).json({ error: err.message });
  }
};

// Export all functions
module.exports = {
  createMedicationOrder: exports.createMedicationOrder,
  getMedicationsByAdmission: exports.getMedicationsByAdmission,
  getMedicationById: exports.getMedicationById,
  getPendingPharmacyRequests: exports.getPendingPharmacyRequests,
  processPharmacyRequest: exports.processPharmacyRequest,
  getNurseTodaySchedule: exports.getNurseTodaySchedule,
  getMedicationScheduleForNurse: exports.getMedicationScheduleForNurse,
  administerMedication: exports.administerMedication,
  skipMedication: exports.skipMedication,
  holdMedication: exports.holdMedication,
  stopMedication: exports.stopMedication,
  requestPharmacy: exports.requestPharmacy,
  getTodaySchedule: exports.getTodaySchedule,
  getMedicationSummary: exports.getMedicationSummary,
  getPatientMedicineStock: exports.getPatientMedicineStock,
  receiveExternalPharmacyStock: exports.receiveExternalPharmacyStock,
  // Helper functions for other modules
  addToPatientMedicineStock,
  deductFromPatientMedicineStock
};