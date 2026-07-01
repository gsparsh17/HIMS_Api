// controllers/ipdMedication.controller.js
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDCharge = require('../models/IPDCharge');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Pharmacy = require('../models/Pharmacy');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const { normaliseBoolean, resolveDoseQtyBaseUnits, calculateMedicationRequiredBaseUnits, generateTimingSlots: generateMedicationTimingSlots, createOrUpdatePharmacyRequest, assertAdmissionHospitalAccess } = require('../services/ipdMedicationFlow.service');

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

// ========== UNIFIED PHARMACY REQUEST FUNCTION ==========
async function createPharmacyRequest(medication, requestedQuantity = null, requestedBy = null, pharmacyId = null) {
  return createOrUpdatePharmacyRequest({
    medication,
    requestedQuantity: requestedQuantity || medication.requiredQtyBaseUnits || 1,
    requestedBy: requestedBy || medication.createdBy || medication.prescribedBy,
    pharmacyId,
    notePrefix: 'Medication indent'
  });
}

// ========== HELPER: Get or Create Patient Medicine Stock ==========
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
      medicationChartIds: [],
      receiptAcknowledged: false
    });
    await stock.save();
  }

  return stock;
}

// ========== HELPER: Add to Patient Medicine Stock ==========
async function addToPatientMedicineStock(admissionId, patientId, medicineId, batchId, quantityBaseUnits, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit, saleId, medicationChartId, stockSource = 'INTERNAL_PHARMACY') {
  const stock = await getOrCreatePatientMedicineStock(
    admissionId, patientId, medicineId, batchId, medicineName, baseUnit, packUnit, unitsPerPack, sellingPricePerBaseUnit
  );

  stock.issuedQtyBaseUnits += quantityBaseUnits;
  stock.currentBalanceBaseUnits += quantityBaseUnits;
  stock.stockSource = stockSource;

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

// ========== HELPER: Deduct from Patient Medicine Stock (UPDATED for NLEM) ==========
async function deductFromPatientMedicineStock(admissionId, patientId, medicineId, quantityBaseUnits, medicationChartId) {
  const required = Number(quantityBaseUnits);
  
  let stocks;
  if (medicineId) {
    stocks = await IPDPatientMedicineStock.find({
      admissionId,
      patientId,
      medicineId: medicineId,
      currentBalanceBaseUnits: { $gt: 0 },
      receiptAcknowledged: true
    }).sort({ lastIssuedAt: 1, createdAt: 1 });
  } else {
    // If no medicineId, return error - this should be handled by the caller
    return { deducted: false, available: 0, error: 'Cannot deduct stock without medicineId' };
  }

  const available = stocks.reduce((sum, stock) => sum + Number(stock.currentBalanceBaseUnits || 0), 0);
  if (available < required) return { deducted: false, available };

  let remaining = required;
  for (const stock of stocks) {
    if (remaining <= 0) break;
    const deductAmount = Math.min(Number(stock.currentBalanceBaseUnits || 0), remaining);
    stock.administeredQtyBaseUnits += deductAmount;
    stock.currentBalanceBaseUnits -= deductAmount;
    if (medicationChartId && !stock.medicationChartIds.some(id => String(id) === String(medicationChartId))) stock.medicationChartIds.push(medicationChartId);
    stock.lastAdministeredAt = new Date();
    await stock.save();
    remaining -= deductAmount;
  }
  return { deducted: true, available: available - required };
}

// ========== MEDICATION CHART CRUD ==========

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
      nlemCode,
      dosageForm,
      doseQtyBaseUnits: requestedDoseQtyBaseUnits,
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

    console.log('[DEBUG] createMedicationOrder - Received request:', {
      admissionId,
      patientId,
      prescribedBy,
      medicineName,
      dosage,
      frequency
    });

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      console.log('[DEBUG] createMedicationOrder - Admission not found');
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

    const doseQtyBaseUnits = resolveDoseQtyBaseUnits({ dosage, dose_quantity: requestedDoseQtyBaseUnits ?? req.body.dose_quantity });
    const requiredQtyBaseUnits = calculateMedicationRequiredBaseUnits({
      dosage,
      doseQtyBaseUnits,
      frequency,
      duration: duration || 1,
      durationUnit: durationUnit || 'Days'
    });

    assertAdmissionHospitalAccess(req, admission);
    if (String(admission.patientId) !== String(patientId)) {
      return res.status(400).json({ success: false, error: 'The selected patient does not belong to this IPD admission.' });
    }
    const pharmacyRequired = normaliseBoolean(requiresPharmacyDispense, false);

    const medication = new IPDMedicationChart({
      admissionId,
      hospitalId: admission.hospitalId || req.user?.hospital_id || null,
      patientId,
      prescribedBy,
      roundId: roundId || null,
      prescriptionId: prescriptionId || null,
      medicineId: medicineId || null,
      medicineName,
      genericName: genericName || medicineName,
      nlemCode: nlemCode || '',
      dosageForm: dosageForm || req.body.medicineType || '',
      doseQtyBaseUnits,
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
      requiresPharmacyDispense: pharmacyRequired,
      costPerUnit,
      requiredQtyBaseUnits,
      status: pharmacyRequired ? 'Requested' : 'Active',
      stockReceiptStatus: pharmacyRequired ? 'PENDING_RECEIPT' : 'NOT_REQUESTED',
      createdBy: req.user?._id
    });

    const timingSlots = generateMedicationTimingSlots(frequency, duration || 1, startDate || new Date());
    medication.timing = timingSlots;

    await medication.save();

    if (pharmacyRequired) {
      await createPharmacyRequest(medication, requiredQtyBaseUnits, req.user?._id);
    }

    const nursingNote = new NursingNote({
      admissionId,
      patientId,
      noteType: 'Medication',
      note: `New medication ordered: ${medicineName} ${dosage} ${route} ${frequency}${requiresPharmacyDispense ? ' - Pharmacy request auto-created' : ''}`,
      priority: isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.status(201).json({
      success: true,
      message: pharmacyRequired
        ? 'Medication order created with pharmacy request'
        : 'Medication order created successfully',
      medication
    });
  } catch (err) {
    console.error('[DEBUG] createMedicationOrder - Error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getMedicationsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { status } = req.query;
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    const filter = { admissionId };
    if (status) filter.status = status;

    const medications = await IPDMedicationChart.find(filter)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name selling_price mrp base_unit pack_unit units_per_pack')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .sort({ startDate: -1 });

    const patientStocks = await IPDPatientMedicineStock.find({ admissionId }).populate('medicineId', 'name strength');

    const normalizeMedicineName = (name) => {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*mg\s*/g, '')
        .replace(/\s*ml\s*/g, '')
        .replace(/\s*g\s*/g, '')
        .trim();
    };

    const stockByIdMap = {};
    const stockByNameMap = {};
    const stockByNormalizedNameMap = {};

    const mergeStockSnapshot = (existing, stock, medicineName, normalizedName) => {
      const current = Number(stock.currentBalanceBaseUnits || 0);
      const issued = Number(stock.issuedQtyBaseUnits || 0);
      const administered = Number(stock.administeredQtyBaseUnits || 0);
      const returned = Number(stock.returnedQtyBaseUnits || 0);
      if (!existing) {
        return {
          currentBalance: current,
          issuedQty: issued,
          administeredQty: administered,
          returnedQty: returned,
          baseUnit: stock.baseUnit || 'unit',
          stockIds: [stock._id],
          medicineName,
          normalizedName,
          receiptAcknowledged: Boolean(stock.receiptAcknowledged),
          stockSource: stock.stockSource
        };
      }
      return {
        ...existing,
        currentBalance: existing.currentBalance + current,
        issuedQty: existing.issuedQty + issued,
        administeredQty: existing.administeredQty + administered,
        returnedQty: existing.returnedQty + returned,
        stockIds: [...(existing.stockIds || []), stock._id],
        receiptAcknowledged: Boolean(existing.receiptAcknowledged && stock.receiptAcknowledged)
      };
    };

    patientStocks.forEach(stock => {
      const medicineId = stock.medicineId?._id?.toString();
      const medicineName = stock.medicineName || stock.medicineId?.name;
      const normalizedName = normalizeMedicineName(medicineName);
      if (medicineId) stockByIdMap[medicineId] = mergeStockSnapshot(stockByIdMap[medicineId], stock, medicineName, normalizedName);
      if (medicineName) {
        stockByNameMap[medicineName] = mergeStockSnapshot(stockByNameMap[medicineName], stock, medicineName, normalizedName);
        stockByNormalizedNameMap[normalizedName] = mergeStockSnapshot(stockByNormalizedNameMap[normalizedName], stock, medicineName, normalizedName);
      }
    });

    const medicationsWithStock = medications.map(med => {
      const medicineId = med.medicineId?._id?.toString();
      const medicineName = med.medicineName;
      const normalizedMedName = normalizeMedicineName(medicineName);

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
        baseUnit: med.medicineId?.base_unit || 'unit',
        receiptAcknowledged: false,
        stockSource: 'INTERNAL_PHARMACY'
      };

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todaysPendingDoses = (med.timing || []).filter(t => {
        const tDate = t.date ? new Date(t.date) : new Date(t.time);
        return !isNaN(tDate.getTime()) && tDate.toDateString() === today.toDateString() && t.status === 'Pending';
      }).length;

      const requiredStockForToday = todaysPendingDoses * Number(med.doseQtyBaseUnits || 1);

      const isReceiptPending = med.stockReceiptStatus === 'PENDING_RECEIPT' &&
        med.pharmacyRequest?.pharmacyStatus === 'Approved';

      return {
        ...med.toObject(),
        stockInfo: finalStockInfo,
        todaysPendingDoses,
        requiredStockForToday,
        isStockSufficient: finalStockInfo.currentBalance >= requiredStockForToday,
        isReceiptPending,
        stockStatus: isReceiptPending ? 'Pending Receipt' :
          finalStockInfo.currentBalance === 0 ? 'No Stock' :
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
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    assertAdmissionHospitalAccess(req, admission);

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

    const requestFilter = {
      'pharmacyRequest.requestedToPharmacy': true,
      'pharmacyRequest.pharmacyId': pharmacyId,
      'pharmacyRequest.pharmacyStatus': 'Pending'
    };
    const userHospitalId = req.user?.hospital_id || req.user?.hospitalId;
    if (userHospitalId && req.user?.role !== 'mediqliq_super_admin') requestFilter.hospitalId = userHospitalId;
    const medications = await IPDMedicationChart.find(requestFilter)
      .populate('admissionId', 'admissionNumber')
      .populate('patientId', 'first_name last_name patientId phone uhid')
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name name strength composition generic_name base_unit pack_unit units_per_pack');

    res.json({ success: true, requests: medications });
  } catch (err) {
    console.error('Error fetching pharmacy requests:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.processPharmacyRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, notes } = req.body;
    const medication = await IPDMedicationChart.findById(id);
    if (!medication) return res.status(404).json({ success: false, error: 'Medication not found.' });

    const admission = await IPDAdmission.findById(medication.admissionId);
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    if (!medication.pharmacyRequest?.requestedToPharmacy) {
      return res.status(400).json({ success: false, error: 'This medication has not been indented to pharmacy.' });
    }
    if (medication.pharmacyRequest.saleId || medication.pharmacyRequest.dispensedFromPharmacy) {
      return res.status(409).json({ success: false, error: 'This pharmacy request has already been sold and dispensed.' });
    }

    if (action === 'reject' || action === 'out_of_stock') {
      medication.pharmacyRequest.pharmacyStatus = action === 'reject' ? 'Rejected' : 'OutOfStock';
      medication.pharmacyRequest.pharmacyNotes = notes || '';
      medication.stockReceiptStatus = 'REJECTED';
      medication.status = 'Requested';
      await medication.save();

      await NursingNote.create({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        noteType: 'Medication',
        note: `Pharmacy ${action === 'reject' ? 'rejected' : 'reported out of stock for'} ${medication.medicineName}. ${notes || ''}`.trim(),
        priority: 'Important',
        createdBy: req.user?._id
      });

      return res.json({
        success: true,
        message: `Pharmacy request marked ${action === 'reject' ? 'rejected' : 'out of stock'}.`,
        medication
      });
    }

    return res.status(409).json({
      success: false,
      error: 'Use the Dispense Medication POS screen to map this clinical order to stock, select a batch, and complete the sale.'
    });
  } catch (err) {
    console.error('Error processing pharmacy request:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Unable to process pharmacy request.' });
  }
};

// ========== NEW API 1: Nurse acknowledges receipt of pharmacy stock ==========
exports.acknowledgeStockReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) return res.status(404).json({ success: false, error: 'Medication not found.' });
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);
    if (!medication.pharmacyRequest?.dispensedFromPharmacy || !medication.pharmacyRequest?.saleId) {
      return res.status(400).json({ success: false, error: 'No completed pharmacy sale is available to acknowledge.' });
    }
    if (medication.pharmacyRequest.stockReceivedByNurse || medication.stockReceiptStatus === 'RECEIVED') {
      return res.status(409).json({ success: false, error: 'This stock receipt has already been acknowledged.' });
    }

    const stock = await IPDPatientMedicineStock.findOneAndUpdate(
      {
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medication.pharmacyRequest.dispensedMedicineId || medication.medicineId?._id,
        batchId: medication.pharmacyRequest.dispensedBatchId,
        sourceSaleIds: medication.pharmacyRequest.saleId
      },
      { $set: { receiptAcknowledged: true, receiptAcknowledgedAt: new Date(), receiptAcknowledgedBy: req.user?._id } },
      { new: true }
    );
    if (!stock) return res.status(409).json({ success: false, error: 'Patient stock allocation for this pharmacy sale was not found. Receipt cannot be acknowledged.' });

    medication.pharmacyRequest.stockReceivedByNurse = true;
    medication.pharmacyRequest.stockReceivedAt = new Date();
    medication.pharmacyRequest.stockReceivedBy = req.user?._id;
    medication.stockReceiptStatus = 'RECEIVED';
    medication.status = 'Active';
    await medication.save();

    await NursingNote.create({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Nurse acknowledged receipt of ${medication.pharmacyRequest.dispensedQuantity} base unit(s) of ${medication.medicineName}. ${notes || ''}`.trim(),
      priority: 'Normal',
      createdBy: req.user?._id
    });
    return res.json({ success: true, message: 'Stock receipt acknowledged. Medication can now be administered.', medication, stock });
  } catch (err) {
    console.error('Error acknowledging stock receipt:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Unable to acknowledge stock receipt.' });
  }
};

// ========== NEW API 2: Get pending stock receipts for nurse ==========
exports.getPendingStockReceipts = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    const medications = await IPDMedicationChart.find({
      admissionId,
      'pharmacyRequest.dispensedFromPharmacy': true,
      'pharmacyRequest.stockReceivedByNurse': false,
      stockReceiptStatus: 'PENDING_RECEIPT',
      status: { $in: ['Active', 'Requested'] }
    })
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name base_unit pack_unit units_per_pack')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .populate('pharmacyRequest.dispensedBatchId', 'batch_number expiry_date')
      .sort({ 'pharmacyRequest.dispensedAt': -1 });

    const medicationsWithStock = await Promise.all(medications.map(async (med) => {
      const stock = await IPDPatientMedicineStock.findOne({
        admissionId: med.admissionId,
        patientId: med.patientId,
        medicineId: med.medicineId?._id,
        batchId: med.pharmacyRequest.dispensedBatchId
      });

      return {
        ...med.toObject(),
        stockDetails: stock || null,
        dispensedQty: med.pharmacyRequest.dispensedQuantity || 0,
        dispensedAt: med.pharmacyRequest.dispensedAt,
        batchNumber: med.pharmacyRequest.dispensedBatchId?.batch_number || 'N/A',
        expiryDate: med.pharmacyRequest.dispensedBatchId?.expiry_date || null
      };
    }));

    res.json({
      success: true,
      count: medicationsWithStock.length,
      pendingReceipts: medicationsWithStock
    });
  } catch (err) {
    console.error('Error fetching pending stock receipts:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== MEDICATION ADMINISTRATION (NURSE) ==========

// Nurse: Request medication from pharmacy
exports.requestPharmacy = async (req, res) => {
  try {
    const { id } = req.params;
    const quantity = Math.ceil(Number(req.body.quantity));
    const medication = await IPDMedicationChart.findById(id);
    if (!medication) return res.status(404).json({ success: false, error: 'Medication not found.' });
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);
    if (medication.status === 'Stopped' || medication.status === 'Completed') return res.status(409).json({ success: false, error: 'Stock cannot be indented for a stopped or completed medication.' });
    const updatedMedication = await createPharmacyRequest(medication, quantity, req.user?._id, req.body.pharmacyId);
    return res.json({ success: true, message: 'Pharmacy indent saved. Pharmacy must process it as an actual sale.', medication: updatedMedication });
  } catch (err) {
    console.error('Error requesting pharmacy:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Unable to request pharmacy stock.' });
  }
};

// Get today's medication schedule for nurse
exports.getNurseTodaySchedule = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const admissionFilter = { status: { $in: ['Admitted', 'Under Treatment'] } };
    const userHospitalId = req.user?.hospital_id || req.user?.hospitalId;
    if (userHospitalId && req.user?.role !== 'mediqliq_super_admin') admissionFilter.hospitalId = userHospitalId;
    const admissions = await IPDAdmission.find(admissionFilter).select('_id');

    const admissionIds = admissions.map(a => a._id);

    const medications = await IPDMedicationChart.find({
      admissionId: { $in: admissionIds },
      status: { $in: ['Active', 'Requested'] },
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
        pendingCount: todaysTimings.length,
        isReceiptPending: med.stockReceiptStatus === 'PENDING_RECEIPT'
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
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
    }
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    const medications = await IPDMedicationChart.find({
      admissionId,
      status: { $in: ['Active', 'Requested'] },
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
        requiredStockForDay: todaysTimings.length * Number(med.doseQtyBaseUnits || 1),
        isReceiptPending: med.stockReceiptStatus === 'PENDING_RECEIPT'
      };
    })).filter(med => med.todaysTimings.length > 0);

    res.json({ success: true, schedule, date: targetDate });
  } catch (err) {
    console.error('Error fetching medication schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== ADMINISTER MEDICATION (UPDATED for NLEM) ==========
exports.administerMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks, witnessedBy } = req.body;
    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) return res.status(404).json({ success: false, error: 'Medication not found.' });
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);
    if (medication.status !== 'Active') return res.status(409).json({ success: false, error: 'Only an active medication can be administered.' });
    if (medication.requiresPharmacyDispense && medication.stockReceiptStatus !== 'RECEIVED') {
      return res.status(409).json({ success: false, error: 'Pharmacy stock must be received and acknowledged before administration.' });
    }

    const timingIndex = medication.timing.findIndex(t => String(t._id) === String(timingId));
    if (timingIndex < 0) return res.status(404).json({ success: false, error: 'Timing slot not found.' });
    if (medication.timing[timingIndex].status !== 'Pending') return res.status(409).json({ success: false, error: 'This timing slot has already been actioned.' });
    if (medication.isHighRisk && medication.requiresDoubleVerification && !witnessedBy) {
      return res.status(400).json({ success: false, error: 'Double verification is required for this high-risk medication.' });
    }

    const doseQtyBaseUnits = Number(medication.doseQtyBaseUnits || resolveDoseQtyBaseUnits({ dosage: medication.dosage }));
    let remainingStock = null;
    const stockMedicineId = medication.pharmacyRequest?.dispensedMedicineId || medication.medicineId?._id;
    
    // ========== FIX: Handle NLEM medicines without medicineId ==========
    if (medication.requiresPharmacyDispense) {
      // If there's no medicineId, find stock by medicineName
      if (!stockMedicineId) {
        // Find stock by medicineName (for NLEM prescriptions)
        const stocks = await IPDPatientMedicineStock.find({
          admissionId: medication.admissionId,
          patientId: medication.patientId,
          medicineName: medication.medicineName,
          medicineId: null,
          currentBalanceBaseUnits: { $gt: 0 },
          receiptAcknowledged: true
        }).sort({ lastIssuedAt: 1, createdAt: 1 });
        
        const available = stocks.reduce((sum, s) => sum + Number(s.currentBalanceBaseUnits || 0), 0);
        if (available < doseQtyBaseUnits) {
          return res.status(409).json({ 
            success: false, 
            error: `Insufficient received stock for ${medication.medicineName}. Available: ${available}, required: ${doseQtyBaseUnits}.` 
          });
        }
        
        // Deduct from stocks
        let remaining = doseQtyBaseUnits;
        for (const stock of stocks) {
          if (remaining <= 0) break;
          const deductAmount = Math.min(Number(stock.currentBalanceBaseUnits || 0), remaining);
          stock.administeredQtyBaseUnits += deductAmount;
          stock.currentBalanceBaseUnits -= deductAmount;
          if (!stock.medicationChartIds.some(id => String(id) === String(medication._id))) {
            stock.medicationChartIds.push(medication._id);
          }
          stock.lastAdministeredAt = new Date();
          await stock.save();
          remaining -= deductAmount;
        }
        remainingStock = available - doseQtyBaseUnits;
      } else {
        // Use the regular deduction with medicineId
        const result = await deductFromPatientMedicineStock(
          medication.admissionId, 
          medication.patientId, 
          stockMedicineId, 
          doseQtyBaseUnits, 
          medication._id
        );
        if (!result.deducted) {
          return res.status(409).json({ 
            success: false, 
            error: `Insufficient received patient stock for ${medication.medicineName}. Available: ${result.available || 0}, required: ${doseQtyBaseUnits}.` 
          });
        }
        remainingStock = result.available;
      }
    }

    medication.timing[timingIndex].status = 'Administered';
    medication.timing[timingIndex].administeredAt = new Date();
    medication.timing[timingIndex].administeredBy = req.user?._id;
    medication.timing[timingIndex].remarks = remarks || '';
    if (witnessedBy) medication.timing[timingIndex].witnessedBy = witnessedBy;
    if (medication.timing.every(t => ['Administered', 'Skipped', 'Held', 'Refused', 'Missed'].includes(t.status))) medication.status = 'Completed';
    await medication.save();

    await NursingNote.create({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Administered ${doseQtyBaseUnits} base unit(s) of ${medication.medicineName} (${medication.dosage}). ${remarks || ''}`.trim(),
      priority: medication.isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id
    });
    return res.json({ success: true, message: 'Medication administration recorded.', medication, remainingStock });
  } catch (err) {
    console.error('Error administering medication:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Unable to administer medication.' });
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
      status: { $in: ['Active', 'Requested'] },
      startDate: { $lte: tomorrow }
    }).populate('prescribedBy', 'firstName lastName');

    const todaySchedule = await Promise.all(medications.map(async (med) => ({
      ...med.toObject(),
      todaysTimings: (med.timing || []).filter(t => {
        const timingDate = new Date(t.date);
        timingDate.setHours(0, 0, 0, 0);
        return timingDate.getTime() === today.getTime();
      }),
      isReceiptPending: med.stockReceiptStatus === 'PENDING_RECEIPT'
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
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    const medications = await IPDMedicationChart.find({ admissionId });

    const summary = {
      total: medications.length,
      active: medications.filter(m => m.status === 'Active').length,
      completed: medications.filter(m => m.status === 'Completed').length,
      stopped: medications.filter(m => m.status === 'Stopped').length,
      pendingPharmacy: medications.filter(m => m.pharmacyRequest?.pharmacyStatus === 'Pending').length,
      pendingReceipt: medications.filter(m => m.stockReceiptStatus === 'PENDING_RECEIPT').length,
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
      currentBalance: patientStocks.reduce((sum, s) => sum + s.currentBalanceBaseUnits, 0),
      pendingReceiptCount: patientStocks.filter(s => !s.receiptAcknowledged).length
    };

    res.json({ success: true, summary, stockSummary });
  } catch (err) {
    console.error('Error fetching medication summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== RECEIVE EXTERNAL PHARMACY STOCK (FIXED for NLEM) ==========
exports.receiveExternalPharmacyStock = async (req, res) => {
  try {
    console.log('[DEBUG] receiveExternalPharmacyStock - START');
    console.log('[DEBUG] Request params:', req.params);
    console.log('[DEBUG] Request body:', req.body);

    const { id } = req.params;
    const { quantity } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }

    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId');
    if (!admission) {
      return res.status(404).json({ error: 'IPD admission not found' });
    }
    assertAdmissionHospitalAccess(req, admission);

    const baseUnit = 'unit';
    const packUnit = 'pack';
    const unitsPerPack = 1;

    // ========== FIX: Handle NLEM prescriptions (medicineId is null) ==========
    // For NLEM prescriptions, medicineId will be null. We track stock by medicineName.
    let medicineId = medication.medicineId?._id || null;
    const medicineName = medication.medicineName || medication.genericName || 'Unknown Medicine';

    console.log('[DEBUG] Medicine ID:', medicineId);
    console.log('[DEBUG] Medicine Name:', medicineName);
    console.log('[DEBUG] Is NLEM (no medicineId):', !medicineId);

    // Try to find existing stock for this medicine
    let patientStock = null;

    if (medicineId) {
      // If we have a medicineId, find stock by medicineId
      patientStock = await IPDPatientMedicineStock.findOne({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medicineId,
      });
    } else {
      // If no medicineId, find stock by medicineName (for NLEM prescriptions)
      patientStock = await IPDPatientMedicineStock.findOne({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineName: medicineName,
        medicineId: null, // Explicitly look for stocks without medicineId
      });
    }

    if (patientStock) {
      console.log('[DEBUG] Found existing patient stock, updating...');
      // Update existing stock
      patientStock.issuedQtyBaseUnits += quantity;
      patientStock.currentBalanceBaseUnits += quantity;
      patientStock.receiptAcknowledged = true;
      patientStock.receiptAcknowledgedAt = new Date();
      patientStock.receiptAcknowledgedBy = req.user?._id;
      patientStock.stockSource = 'EXTERNAL_PHARMACY';
      patientStock.lastIssuedAt = new Date();

      if (!patientStock.medicationChartIds.some(id => String(id) === String(medication._id))) {
        patientStock.medicationChartIds.push(medication._id);
      }

      await patientStock.save();
      console.log('[DEBUG] Updated existing stock:', patientStock._id);
    } else {
      console.log('[DEBUG] No existing stock found, creating new...');
      // Create new stock entry
      patientStock = new IPDPatientMedicineStock({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medicineId, // Will be null for NLEM prescriptions
        batchId: null,
        medicineName: medicineName,
        baseUnit: baseUnit,
        packUnit: packUnit,
        unitsPerPack: unitsPerPack,
        issuedQtyBaseUnits: quantity,
        administeredQtyBaseUnits: 0,
        returnedQtyBaseUnits: 0,
        currentBalanceBaseUnits: quantity,
        sourceSaleIds: [],
        medicationChartIds: [medication._id],
        receiptAcknowledged: true,
        receiptAcknowledgedAt: new Date(),
        receiptAcknowledgedBy: req.user?._id,
        stockSource: 'EXTERNAL_PHARMACY',
        lastIssuedAt: new Date()
      });

      await patientStock.save();
      console.log('[DEBUG] Created new stock:', patientStock._id);
    }

    // Update medication status
    medication.status = 'Active';
    medication.stockReceiptStatus = 'RECEIVED';

    if (!medication.pharmacyRequest) {
      medication.pharmacyRequest = {};
    }

    medication.pharmacyRequest.requestedToPharmacy = false;
    medication.pharmacyRequest.requestedAt = medication.pharmacyRequest.requestedAt || new Date();
    medication.pharmacyRequest.requestedBy = medication.pharmacyRequest.requestedBy || req.user?._id;
    medication.pharmacyRequest.requestedQuantity = quantity;
    medication.pharmacyRequest.pharmacyStatus = 'Approved';
    medication.pharmacyRequest.dispensedFromPharmacy = true;
    medication.pharmacyRequest.dispensedQuantity = quantity;
    medication.pharmacyRequest.dispensedAt = new Date();
    medication.pharmacyRequest.stockReceivedByNurse = true;
    medication.pharmacyRequest.stockReceivedAt = new Date();
    medication.pharmacyRequest.stockReceivedBy = req.user?._id;

    await medication.save();

    await NursingNote.create({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Received ${quantity} base unit(s) of ${medicineName} from external pharmacy. ${medicineId ? 'Mapped to medicine ID: ' + medicineId : 'NLEM medicine (not in inventory)'}. Stock is now available for administration.`,
      priority: 'Normal',
      createdBy: req.user?._id
    });

    console.log('[DEBUG] receiveExternalPharmacyStock - SUCCESS');
    res.json({
      success: true,
      message: `Successfully received ${quantity} units of ${medicineName} from external pharmacy`,
      medication,
      stock: patientStock
    });
  } catch (err) {
    console.error('[DEBUG] receiveExternalPharmacyStock - ERROR:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to receive external pharmacy stock',
      debug: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};

// Get patient medicine stock
exports.getPatientMedicineStock = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

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
  acknowledgeStockReceipt: exports.acknowledgeStockReceipt,
  getPendingStockReceipts: exports.getPendingStockReceipts,
  addToPatientMedicineStock,
  deductFromPatientMedicineStock
};