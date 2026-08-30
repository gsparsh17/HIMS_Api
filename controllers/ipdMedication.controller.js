const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
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
const { userHospitalId, isPlatformAdmin } = require('../utils/hospitalScope');
const Patient = require('../models/Patient');
const { getOrCreateNabhSetting } = require('../services/nabhSetting.service');
const { assertAdmissionOpenForMutation } = require('../services/ipdLifecycleGuard.service');
const { resolveClinicalActor, resolveNurseWitness } = require('../services/clinicalActor.service');

function assertAdmissionClinicallyOpen(admission) {
  return assertAdmissionOpenForMutation(admission, { action: 'Clinical medication activity' });
}

async function loadScopedMedication(req, id, { session = null, populateMedicine = false } = {}) {
  let query = IPDMedicationChart.findById(id);
  if (session) query = query.session(session);
  if (populateMedicine) query = query.populate('medicineId');
  const medication = await query;
  if (!medication) return { medication: null, admission: null };
  let admissionQuery = IPDAdmission.findById(medication.admissionId).select('hospitalId status chargeFreeze');
  if (session) admissionQuery = admissionQuery.session(session);
  const admission = await admissionQuery;
  if (!admission) return { medication, admission: null };
  assertAdmissionHospitalAccess(req, admission);
  assertAdmissionClinicallyOpen(admission);
  return { medication, admission };
}

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
  const today = operationNow();
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
async function createPharmacyRequest(medication, requestedQuantity = null, requestedBy = null, pharmacyId = null, session = null) {
  return createOrUpdatePharmacyRequest({
    medication,
    requestedQuantity: requestedQuantity || medication.requiredQtyBaseUnits || 1,
    requestedBy: requestedBy || medication.createdBy || medication.prescribedBy,
    pharmacyId,
    notePrefix: 'Medication indent',
    session
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

  stock.lastIssuedAt = operationNow();
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
    stock.lastAdministeredAt = operationNow();
    await stock.save();
    remaining -= deductAmount;
  }
  return { deducted: true, available: available - required };
}

// ========== MEDICATION CHART CRUD ==========

// Create medication order (from Doctor Round)
const MEDICATION_ROUTE_ALIASES = { IV: 'Intravenous', IM: 'Intramuscular', SC: 'Subcutaneous', PO: 'Oral' };
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
      route: requestedRoute,
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

    const route = MEDICATION_ROUTE_ALIASES[String(requestedRoute || '').toUpperCase()] || requestedRoute;

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
      medicineDetails = await Medicine.findOne({ _id: medicineId, hospitalId: admission.hospitalId });
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
    assertAdmissionClinicallyOpen(admission);
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
      startDate: startDate || operationNow(),
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

    const timingSlots = generateMedicationTimingSlots(frequency, duration || 1, startDate || operationNow());
    medication.timing = timingSlots;

    await medication.save();

    if (pharmacyRequired) {
      await createPharmacyRequest(medication, requiredQtyBaseUnits, req.user?._id);
    }

    const nursingNote = new NursingNote({
      hospitalId: admission.hospitalId,
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
    const status = ['ValidationError','CastError'].includes(err?.name) ? 400 : Number(err?.statusCode || 500);
    res.status(status).json({ error: err.message });
  }
};

exports.getMedicationsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { status } = req.query;
    const admission = await IPDAdmission.findById(admissionId).select('hospitalId');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);

    const filter = { hospitalId: admission.hospitalId, admissionId };
    if (status) filter.status = status;

    const medications = await IPDMedicationChart.find(filter)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name selling_price mrp base_unit pack_unit units_per_pack')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .sort({ startDate: -1 });

    const patientStocks = await IPDPatientMedicineStock.find({ hospitalId: admission.hospitalId, admissionId }).populate('medicineId', 'name strength');

    const normalizeMedicineName = (name) => {
      if (!name) return '';
      // Keep strength/form tokens intact. Stripping mg/ml/g or doing substring
      // matching can reconcile bedside stock to the wrong strength/form.
      return String(name).toLowerCase().replace(/\s+/g, ' ').trim();
    };

    const stockByIdMap = {};
    const stockByNameMap = {};
    const stockByNormalizedNameMap = {};

    const mergeStockSnapshot = (existing, stock, medicineName, normalizedName) => {
      const physicalBalance = Number(stock.currentBalanceBaseUnits || 0);
      const current = stock.receiptAcknowledged ? physicalBalance : 0;
      const pendingReceiptBalance = stock.receiptAcknowledged ? 0 : physicalBalance;
      const issued = Number(stock.issuedQtyBaseUnits || 0);
      const administered = Number(stock.administeredQtyBaseUnits || 0);
      const returned = Number(stock.returnedQtyBaseUnits || 0);
      if (!existing) {
        return {
          currentBalance: current,
          pendingReceiptBalance,
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
        pendingReceiptBalance: Number(existing.pendingReceiptBalance || 0) + pendingReceiptBalance,
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
        // Exact normalized-name fallback is only for legacy/NLEM rows that have
        // no stable medicineId. Never use substring/fuzzy medicine matching.
        stockInfo = stockByNormalizedNameMap[normalizedMedName];
      }

      const finalStockInfo = stockInfo || {
        currentBalance: 0,
        pendingReceiptBalance: 0,
        issuedQty: 0,
        administeredQty: 0,
        returnedQty: 0,
        baseUnit: med.medicineId?.base_unit || 'unit',
        receiptAcknowledged: false,
        stockSource: 'INTERNAL_PHARMACY'
      };

      const today = operationNow();
      today.setHours(0, 0, 0, 0);
      const todaysPendingDoses = (med.timing || []).filter(t => {
        const tDate = t.date ? new Date(t.date) : new Date(t.time);
        return !isNaN(tDate.getTime()) && tDate.toDateString() === today.toDateString() && t.status === 'Pending';
      }).length;

      const requiredStockForToday = todaysPendingDoses * Number(med.doseQtyBaseUnits || 1);

      const isReceiptPending = med.stockReceiptStatus === 'PENDING_RECEIPT';

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
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId status');
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    assertAdmissionHospitalAccess(req, admission);

    const patientStocks = await IPDPatientMedicineStock.find({
      hospitalId: admission.hospitalId,
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      medicineId: medication.medicineId?._id || medication.medicineId,
      receiptAcknowledged: true
    }).select('currentBalanceBaseUnits');
    const patientStockBalance = patientStocks.reduce((sum, stock) => sum + Number(stock.currentBalanceBaseUnits || 0), 0);

    res.json({
      success: true,
      medication,
      patientStockBalance
    });
  } catch (err) {
    console.error('Error fetching medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Doctor: continue, modify, or stop an existing medication order during a round.
// Already administered timing rows are retained. Only future pending timings are
// rebuilt when the dose, route, frequency, or duration changes.
exports.changeMedicationOrder = async (req, res) => {
  try {
    const session = req.transactionSession || null;
    const medication = await IPDMedicationChart.findById(req.params.id).session(session || null);
    if (!medication) return res.status(404).json({ error: 'Medication not found' });

    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId patientId status chargeFreeze').session(session || null);
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    assertAdmissionHospitalAccess(req, admission);
    assertAdmissionClinicallyOpen(admission);
    const actor = await resolveClinicalActor(req.user, { session });

    const action = String(req.body.action || 'modify').toLowerCase();
    if (!['continue', 'modify', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'Action must be continue, modify, or stop' });
    }

    const requestedRoundId = req.body.roundId || null;
    const lastChange = (medication.changeHistory || []).length
      ? medication.changeHistory[medication.changeHistory.length - 1]
      : null;
    const expectedHistoryAction = action === 'stop' ? 'Stopped' : action === 'continue' ? 'Continued' : 'Modified';
    if (requestedRoundId && String(medication.lastChangedRoundId || '') === String(requestedRoundId) && lastChange?.action === expectedHistoryAction) {
      return res.json({ success: true, alreadyApplied: true, message: 'Medication change already applied for this ward round', medication });
    }

    const previous = {
      status: medication.status,
      route: medication.route,
      dosage: medication.dosage,
      doseQtyBaseUnits: medication.doseQtyBaseUnits,
      frequency: medication.frequency,
      duration: medication.duration,
      durationUnit: medication.durationUnit,
      specialInstructions: medication.specialInstructions,
      requiresPharmacyDispense: medication.requiresPharmacyDispense,
      requiredQtyBaseUnits: medication.requiredQtyBaseUnits
    };
    const changedAt = operationNow();
    const roundId = requestedRoundId;
    const reason = String(req.body.reason || req.body.stoppedReason || '').trim();

    if (action === 'stop') {
      if (!reason) return res.status(400).json({ error: 'Reason is required when stopping a medication' });
      if (['Stopped', 'Completed'].includes(medication.status)) {
        return res.status(409).json({ error: `Medication is already ${medication.status.toLowerCase()}` });
      }

      medication.status = 'Stopped';
      medication.stoppedReason = reason;
      medication.stoppedAt = changedAt;
      medication.stoppedByUser = actor.userId;
      medication.stoppedByNameSnapshot = actor.name;
      if (actor.staffModel === 'Doctor' && actor.staffProfileId) medication.stoppedBy = actor.staffProfileId;
      medication.endDate = changedAt;
      medication.timing.forEach((timing) => {
        if (timing.status === 'Pending') {
          timing.status = 'Held';
          timing.remarks = `Medication stopped: ${reason}`;
        }
      });
    } else if (action === 'modify') {
      if (['Stopped', 'Completed'].includes(medication.status)) {
        return res.status(409).json({ error: `A ${medication.status.toLowerCase()} medication cannot be modified` });
      }

      const editableFields = [
        'route',
        'dosage',
        'frequency',
        'duration',
        'durationUnit',
        'specialInstructions'
      ];
      editableFields.forEach((field) => {
        if (req.body[field] !== undefined) medication[field] = req.body[field];
      });

      if (req.body.requiresPharmacyDispense !== undefined) {
        medication.requiresPharmacyDispense = normaliseBoolean(
          req.body.requiresPharmacyDispense,
          medication.requiresPharmacyDispense
        );
      }
      if (req.body.doseQtyBaseUnits !== undefined || req.body.dose_quantity !== undefined) {
        medication.doseQtyBaseUnits = resolveDoseQtyBaseUnits({
          doseQtyBaseUnits: req.body.doseQtyBaseUnits,
          dose_quantity: req.body.dose_quantity,
          dosage: medication.dosage
        });
      }

      medication.duration = Math.max(1, Number(medication.duration || 1));
      medication.requiredQtyBaseUnits = calculateMedicationRequiredBaseUnits({
        dosage: medication.dosage,
        doseQtyBaseUnits: medication.doseQtyBaseUnits,
        frequency: medication.frequency,
        duration: medication.duration,
        durationUnit: medication.durationUnit
      });

      const effectiveFrom = req.body.effectiveFrom ? new Date(req.body.effectiveFrom) : changedAt;
      if (Number.isNaN(effectiveFrom.getTime())) {
        return res.status(400).json({ error: 'Invalid effective date for medication change' });
      }

      const effectiveDay = new Date(effectiveFrom);
      effectiveDay.setHours(0, 0, 0, 0);
      const retainedTimings = medication.timing.filter((timing) => {
        if (timing.status !== 'Pending') return true;
        const timingDate = new Date(timing.date);
        return !Number.isNaN(timingDate.getTime()) && timingDate < effectiveDay;
      });
      const replacementTimings = generateMedicationTimingSlots(
        medication.frequency,
        medication.duration,
        effectiveDay
      );
      const timingKeys = new Set(retainedTimings.map((timing) => {
        const date = new Date(timing.date);
        return `${date.toISOString().slice(0, 10)}|${timing.time}`;
      }));

      replacementTimings.forEach((timing) => {
        const date = new Date(timing.date);
        const key = `${date.toISOString().slice(0, 10)}|${timing.time}`;
        if (!timingKeys.has(key)) {
          retainedTimings.push(timing);
          timingKeys.add(key);
        }
      });
      medication.timing = retainedTimings.sort((left, right) => {
        const leftDate = new Date(left.date).getTime();
        const rightDate = new Date(right.date).getTime();
        if (leftDate !== rightDate) return leftDate - rightDate;
        return String(left.time).localeCompare(String(right.time));
      });

      if (medication.status === 'Pending') medication.status = 'Active';
      if (medication.requiresPharmacyDispense && !medication.pharmacyRequest?.dispensedFromPharmacy) {
        await createPharmacyRequest(
          medication,
          medication.requiredQtyBaseUnits,
          req.user?._id,
          medication.pharmacyRequest?.pharmacyId,
          session
        );
      }
    }

    const next = {
      status: medication.status,
      route: medication.route,
      dosage: medication.dosage,
      doseQtyBaseUnits: medication.doseQtyBaseUnits,
      frequency: medication.frequency,
      duration: medication.duration,
      durationUnit: medication.durationUnit,
      specialInstructions: medication.specialInstructions,
      requiresPharmacyDispense: medication.requiresPharmacyDispense,
      requiredQtyBaseUnits: medication.requiredQtyBaseUnits
    };

    medication.changeHistory.push({
      action: action === 'stop' ? 'Stopped' : action === 'continue' ? 'Continued' : 'Modified',
      changedAt,
      changedBy: req.user?._id,
      roundId,
      reason,
      previous,
      next
    });
    medication.lastChangedAt = changedAt;
    medication.lastChangedBy = req.user?._id;
    medication.lastChangedRoundId = roundId;
    await medication.save(session ? { session } : undefined);

    const description = action === 'stop'
      ? `Medication stopped: ${medication.medicineName}. Reason: ${reason}`
      : action === 'continue'
        ? `Medication continued without change: ${medication.medicineName}.`
        : `Medication order changed: ${medication.medicineName} from ${previous.dosage} ${previous.frequency} to ${medication.dosage} ${medication.frequency}.${reason ? ` Reason: ${reason}` : ''}`;

    const medicationChangeNote = {
      hospitalId: admission.hospitalId,
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      noteType: 'Medication',
      note: description,
      priority: action === 'stop' ? 'Important' : 'Normal',
      actorUserId: actor.userId,
      actorRole: actor.role,
      actorNameSnapshot: actor.name,
      createdBy: req.user?._id
    };
    if (session) await NursingNote.create([medicationChangeNote], { session });
    else await NursingNote.create(medicationChangeNote);

    return res.json({
      success: true,
      message: action === 'continue'
        ? 'Medication continued'
        : action === 'stop'
          ? 'Medication stopped successfully'
          : 'Medication order updated successfully',
      medication
    });
  } catch (error) {
    console.error('Error changing medication order:', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
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
    const scopedHospitalId = userHospitalId(req.user);
    if (scopedHospitalId && !isPlatformAdmin(req.user)) requestFilter.hospitalId = scopedHospitalId;
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
    assertAdmissionClinicallyOpen(admission);

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

      const pharmacyActor = await resolveClinicalActor(req.user);
      await NursingNote.create({
        hospitalId: admission.hospitalId,
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        actorUserId: pharmacyActor.userId,
        actorRole: pharmacyActor.role,
        actorNameSnapshot: pharmacyActor.name,
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
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId status chargeFreeze finalDischargedAt');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);
    assertAdmissionClinicallyOpen(admission);
    if (!medication.pharmacyRequest?.dispensedFromPharmacy || !medication.pharmacyRequest?.saleId) {
      return res.status(400).json({ success: false, error: 'No completed pharmacy sale is available to acknowledge.' });
    }
    if (medication.pharmacyRequest.stockReceivedByNurse || medication.stockReceiptStatus === 'RECEIVED') {
      return res.status(409).json({ success: false, error: 'This stock receipt has already been acknowledged.' });
    }

    const stock = await IPDPatientMedicineStock.findOneAndUpdate(
      {
        hospitalId: admission.hospitalId,
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medication.pharmacyRequest.dispensedMedicineId || medication.medicineId?._id,
        batchId: medication.pharmacyRequest.dispensedBatchId,
        sourceSaleIds: medication.pharmacyRequest.saleId
      },
      { $set: { receiptAcknowledged: true, receiptAcknowledgedAt: operationNow(), receiptAcknowledgedBy: req.user?._id } },
      { new: true }
    );
    if (!stock) return res.status(409).json({ success: false, error: 'Patient stock allocation for this pharmacy sale was not found. Receipt cannot be acknowledged.' });

    medication.pharmacyRequest.stockReceivedByNurse = true;
    medication.pharmacyRequest.stockReceivedAt = operationNow();
    medication.pharmacyRequest.stockReceivedBy = req.user?._id;
    const latestHistory = medication.pharmacyRequest.dispenseHistory?.find((row) => String(row.saleId) === String(medication.pharmacyRequest.saleId));
    if (latestHistory) { latestHistory.receivedAt = operationNow(); latestHistory.receivedBy = req.user?._id; }
    medication.stockReceiptStatus = 'RECEIVED';
    if (Number(medication.pharmacyRequest.dispensedQuantity || 0) >= Number(medication.pharmacyRequest.requestedQuantity || 0)) {
      medication.pharmacyRequest.pharmacyStatus = 'Delivered';
    } else {
      medication.pharmacyRequest.pharmacyStatus = 'PartiallyDispensed';
    }
    medication.status = 'Active';
    await medication.save();

    const receiptActor = await resolveClinicalActor(req.user);
    await NursingNote.create({
      hospitalId: admission.hospitalId,
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      ...(receiptActor.staffModel === 'Nurse' && receiptActor.staffProfileId ? { nurseId: receiptActor.staffProfileId } : {}),
      actorUserId: receiptActor.userId,
      actorRole: receiptActor.role,
      actorNameSnapshot: receiptActor.name,
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
    assertAdmissionClinicallyOpen(admission);

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
        hospitalId: admission.hospitalId,
        admissionId: med.admissionId,
        patientId: med.patientId,
        medicineId: med.pharmacyRequest?.dispensedMedicineId || med.medicineId?._id,
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
    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId status chargeFreeze finalDischargedAt');
    if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    assertAdmissionHospitalAccess(req, admission);
    assertAdmissionClinicallyOpen(admission);
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
    const today = operationNow();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const admissionFilter = { status: { $in: ['Admitted', 'Under Treatment', 'Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge'] } };
    const scopedHospitalId = userHospitalId(req.user);
    if (scopedHospitalId && !isPlatformAdmin(req.user)) admissionFilter.hospitalId = scopedHospitalId;
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

    let targetDate = operationNow();
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
        const stocks = await IPDPatientMedicineStock.find({
          hospitalId: admission.hospitalId,
          admissionId,
          patientId: med.patientId,
          medicineId: med.medicineId._id,
          receiptAcknowledged: true
        }).select('currentBalanceBaseUnits').lean();
        patientStockBalance = stocks.reduce((sum, stock) => sum + Number(stock.currentBalanceBaseUnits || 0), 0);
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
  const session = await mongoose.startSession();
  try {
    const { id } = req.params;
    const { timingId, remarks, witnessedBy, witnessedByUserId } = req.body;

    // Read policy/identity prerequisites before opening the write transaction.
    const initial = await loadScopedMedication(req, id, { populateMedicine: true });
    if (!initial.medication) return res.status(404).json({ success: false, error: 'Medication not found.' });
    if (!initial.admission) return res.status(404).json({ success: false, error: 'IPD admission not found.' });
    const setting = await getOrCreateNabhSetting(initial.admission.hospitalId, req.user._id);
    const identityRequired = Boolean(setting?.medication?.requirePatientBarcodeAtAdministration || initial.medication.medicineId?.medicationSafety?.patientBarcodeRequired);
    if (identityRequired) {
      const supplied = String(req.body.patientIdentifier || '').trim();
      if (!supplied) return res.status(400).json({ success: false, error: 'Patient identifier scan/entry is required before medication administration.' });
      const patient = await Patient.findOne({ _id: initial.medication.patientId, hospitalId: initial.admission.hospitalId }).select('patientId uhid');
      if (!patient || ![String(patient._id), String(patient.patientId || ''), String(patient.uhid || '')].includes(supplied)) {
        return res.status(409).json({ success: false, error: 'Patient identifier does not match the medication order.' });
      }
    }

    let resultMedication = null;
    let remainingStock = null;
    await session.withTransaction(async () => {
      const scoped = await loadScopedMedication(req, id, { session, populateMedicine: true });
      const medication = scoped.medication;
      const admission = scoped.admission;
      if (!medication) { const e = new Error('Medication not found.'); e.statusCode = 404; throw e; }
      if (!admission) { const e = new Error('IPD admission not found.'); e.statusCode = 404; throw e; }
      if (medication.status !== 'Active') { const e = new Error('Only an active medication can be administered.'); e.statusCode = 409; throw e; }
      if (medication.requiresPharmacyDispense && medication.stockReceiptStatus !== 'RECEIVED') {
        const e = new Error('Pharmacy stock must be received and acknowledged before administration.'); e.statusCode = 409; throw e;
      }

      const timingIndex = medication.timing.findIndex((t) => String(t._id) === String(timingId));
      if (timingIndex < 0) { const e = new Error('Timing slot not found.'); e.statusCode = 404; throw e; }
      if (medication.timing[timingIndex].status !== 'Pending') { const e = new Error('This timing slot has already been actioned.'); e.statusCode = 409; throw e; }
      if (medication.isHighRisk && medication.requiresDoubleVerification && !witnessedBy && !witnessedByUserId) {
        const e = new Error('Double verification is required for this high-risk medication.'); e.statusCode = 400; throw e;
      }

      const actor = await resolveClinicalActor(req.user, { session });
      let witnessActor = null;
      if (witnessedBy || witnessedByUserId) {
        witnessActor = await resolveNurseWitness({
          hospitalId: admission.hospitalId,
          userId: witnessedByUserId || null,
          nurseId: witnessedByUserId ? null : witnessedBy,
          session
        });
        if (!witnessActor?.nurseProfileId) {
          const e = new Error('Medication witness must resolve to a valid Nurse profile in this hospital.');
          e.statusCode = 409;
          e.code = 'INVALID_MEDICATION_WITNESS';
          throw e;
        }
        if ((witnessActor.userId && String(witnessActor.userId) === String(actor.userId)) ||
            (actor.staffModel === 'Nurse' && actor.staffProfileId && String(witnessActor.nurseProfileId) === String(actor.staffProfileId))) {
          const e = new Error('High-risk medication witness must be a different nurse from the administering clinician.');
          e.statusCode = 409;
          e.code = 'MEDICATION_WITNESS_MUST_DIFFER';
          throw e;
        }
      }

      const doseQtyBaseUnits = Number(medication.doseQtyBaseUnits || resolveDoseQtyBaseUnits({ dosage: medication.dosage }));
      const stockMedicineId = medication.pharmacyRequest?.dispensedMedicineId || medication.medicineId?._id;
      if (medication.requiresPharmacyDispense) {
        const stockFilter = {
          hospitalId: admission.hospitalId,
          admissionId: medication.admissionId,
          patientId: medication.patientId,
          currentBalanceBaseUnits: { $gt: 0 },
          receiptAcknowledged: true,
          ...(stockMedicineId
            ? { medicineId: stockMedicineId }
            : { medicineId: null, medicineName: medication.medicineName })
        };
        const stocks = await IPDPatientMedicineStock.find(stockFilter).sort({ lastIssuedAt: 1, createdAt: 1 }).session(session);
        const available = stocks.reduce((sum, row) => sum + Number(row.currentBalanceBaseUnits || 0), 0);
        if (available < doseQtyBaseUnits) {
          const e = new Error(`Insufficient received patient stock for ${medication.medicineName}. Available: ${available}, required: ${doseQtyBaseUnits}.`);
          e.statusCode = 409;
          throw e;
        }
        let remaining = doseQtyBaseUnits;
        for (const stock of stocks) {
          if (remaining <= 0) break;
          const deductAmount = Math.min(Number(stock.currentBalanceBaseUnits || 0), remaining);
          stock.administeredQtyBaseUnits = Number(stock.administeredQtyBaseUnits || 0) + deductAmount;
          stock.currentBalanceBaseUnits = Number(stock.currentBalanceBaseUnits || 0) - deductAmount;
          if (!stock.medicationChartIds.some((chartId) => String(chartId) === String(medication._id))) stock.medicationChartIds.push(medication._id);
          stock.lastAdministeredAt = operationNow();
          await stock.save({ session });
          remaining -= deductAmount;
        }
        remainingStock = available - doseQtyBaseUnits;
      }

      medication.timing[timingIndex].status = 'Administered';
      medication.timing[timingIndex].administeredAt = operationNow();
      medication.timing[timingIndex].administeredByUser = actor.userId;
      medication.timing[timingIndex].administeredByStaffProfile = actor.staffProfileId || undefined;
      medication.timing[timingIndex].administeredByStaffModel = actor.staffModel || undefined;
      // Preserve legacy Nurse ref only when the authenticated actor actually has
      // a Nurse profile. User IDs are never written into a Nurse/Doctor ref.
      if (actor.staffModel === 'Nurse' && actor.staffProfileId) medication.timing[timingIndex].administeredBy = actor.staffProfileId;
      medication.timing[timingIndex].administeredByInitials = req.user?.initials || actor.name || '';
      medication.timing[timingIndex].signOffName = actor.name || '';
      medication.timing[timingIndex].remarks = remarks || '';
      if (witnessActor) {
        if (witnessActor.userId) medication.timing[timingIndex].witnessedByUser = witnessActor.userId;
        medication.timing[timingIndex].witnessedBy = witnessActor.nurseProfileId;
        medication.timing[timingIndex].witnessedByInitials = witnessActor.name || '';
      }
      if (medication.timing.every((t) => ['Administered', 'Skipped', 'Held', 'Refused', 'Missed'].includes(t.status))) medication.status = 'Completed';
      await medication.save({ session });

      await NursingNote.create([{
        hospitalId: admission.hospitalId,
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        ...(actor.staffModel === 'Nurse' && actor.staffProfileId ? { nurseId: actor.staffProfileId } : {}),
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorNameSnapshot: actor.name,
        noteType: 'Medication',
        note: `Administered ${doseQtyBaseUnits} base unit(s) of ${medication.medicineName} (${medication.dosage}). ${remarks || ''}`.trim(),
        priority: medication.isHighRisk ? 'Important' : 'Normal',
        createdBy: req.user?._id
      }], { session });
      resultMedication = medication;
    });

    return res.json({ success: true, message: 'Medication administration recorded.', medication: resultMedication, remainingStock });
  } catch (err) {
    console.error('Error administering medication:', err);
    return res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Unable to administer medication.' });
  } finally {
    await session.endSession();
  }
};

// Skip medication (Nurse action)
exports.skipMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks } = req.body;
    const { medication, admission } = await loadScopedMedication(req, id);
    if (!medication) return res.status(404).json({ error: 'Medication not found' });
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    if (medication.status !== 'Active') return res.status(409).json({ error: 'Only an active medication can be skipped' });
    const timingIndex = medication.timing.findIndex((t) => String(t._id) === String(timingId));
    if (timingIndex === -1) return res.status(404).json({ error: 'Timing not found' });
    if (medication.timing[timingIndex].status !== 'Pending') return res.status(409).json({ error: 'Only a pending timing slot can be skipped' });
    medication.timing[timingIndex].status = 'Skipped';
    medication.timing[timingIndex].remarks = remarks || '';
    const actor = await resolveClinicalActor(req.user);
    await medication.save();
    await NursingNote.create({ hospitalId: admission.hospitalId, admissionId: medication.admissionId, patientId: medication.patientId, ...(actor.staffModel === 'Nurse' && actor.staffProfileId ? { nurseId: actor.staffProfileId } : {}), actorUserId: actor.userId, actorRole: actor.role, actorNameSnapshot: actor.name, noteType: 'Medication', note: `Medication skipped: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`, priority: 'Normal', createdBy: req.user?._id });
    return res.json({ success: true, message: 'Medication skipped', medication });
  } catch (err) {
    console.error('Error skipping medication:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Hold medication (Nurse/Doctor action)
exports.holdMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks } = req.body;
    const { medication, admission } = await loadScopedMedication(req, id);
    if (!medication) return res.status(404).json({ error: 'Medication not found' });
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    if (medication.status !== 'Active') return res.status(409).json({ error: 'Only an active medication can be held' });
    const timingIndex = medication.timing.findIndex((t) => String(t._id) === String(timingId));
    if (timingIndex === -1) return res.status(404).json({ error: 'Timing not found' });
    if (medication.timing[timingIndex].status !== 'Pending') return res.status(409).json({ error: 'Only a pending timing slot can be held' });
    medication.timing[timingIndex].status = 'Held';
    medication.timing[timingIndex].remarks = remarks || '';
    const actor = await resolveClinicalActor(req.user);
    await medication.save();
    await NursingNote.create({ hospitalId: admission.hospitalId, admissionId: medication.admissionId, patientId: medication.patientId, ...(actor.staffModel === 'Nurse' && actor.staffProfileId ? { nurseId: actor.staffProfileId } : {}), actorUserId: actor.userId, actorRole: actor.role, actorNameSnapshot: actor.name, noteType: 'Medication', note: `Medication held: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`, priority: 'Important', createdBy: req.user?._id });
    return res.json({ success: true, message: 'Medication held', medication });
  } catch (err) {
    console.error('Error holding medication:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Stop medication order (Doctor action)
exports.stopMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { stoppedReason } = req.body;
    const { medication, admission } = await loadScopedMedication(req, id);
    if (!medication) return res.status(404).json({ error: 'Medication not found' });
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    if (['Stopped', 'Completed'].includes(medication.status)) return res.status(409).json({ error: `Medication is already ${medication.status}` });
    if (!String(stoppedReason || '').trim()) return res.status(400).json({ error: 'Stopped reason is required' });
    medication.status = 'Stopped';
    const actor = await resolveClinicalActor(req.user);
    medication.stoppedReason = stoppedReason;
    medication.stoppedAt = operationNow();
    medication.endDate = medication.stoppedAt;
    medication.stoppedByUser = actor.userId;
    medication.stoppedByNameSnapshot = actor.name;
    if (actor.staffModel === 'Doctor' && actor.staffProfileId) medication.stoppedBy = actor.staffProfileId;
    await medication.save();
    await NursingNote.create({ hospitalId: admission.hospitalId, admissionId: medication.admissionId, patientId: medication.patientId, ...(actor.staffModel === 'Nurse' && actor.staffProfileId ? { nurseId: actor.staffProfileId } : {}), actorUserId: actor.userId, actorRole: actor.role, actorNameSnapshot: actor.name, noteType: 'Medication', note: `Medication stopped: ${medication.medicineName}. Reason: ${stoppedReason}`, priority: 'Normal', createdBy: req.user?._id });
    return res.json({ success: true, message: 'Medication stopped successfully', medication });
  } catch (err) {
    console.error('Error stopping medication:', err);
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Get medication schedule for today (admission specific)
exports.getTodaySchedule = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const today = operationNow();
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

    const medications = await IPDMedicationChart.find({ hospitalId: admission.hospitalId, admissionId });

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

    const patientStocks = await IPDPatientMedicineStock.find({ hospitalId: admission.hospitalId, admissionId });
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

    const { id } = req.params;
    const { quantity, sourceType = 'PATIENT_SUPPLIED', receivedFrom, batchNumber, expiryDate, manufacturer, referenceNumber, verificationNote } = req.body;

    if (!quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }
    if (!String(receivedFrom || '').trim() || !String(verificationNote || '').trim()) {
      return res.status(400).json({ error: 'External stock requires receivedFrom and verificationNote for medication traceability' });
    }

    const medication = await IPDMedicationChart.findById(id).populate('medicineId');
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const admission = await IPDAdmission.findById(medication.admissionId).select('hospitalId status chargeFreeze finalDischargedAt');
    if (!admission) {
      return res.status(404).json({ error: 'IPD admission not found' });
    }
    assertAdmissionHospitalAccess(req, admission);
    assertAdmissionClinicallyOpen(admission);

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
        hospitalId: admission.hospitalId,
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        medicineId: medicineId,
        stockSource: 'EXTERNAL_PHARMACY',
      });
    } else {
      // If no medicineId, find stock by medicineName (for NLEM prescriptions)
      patientStock = await IPDPatientMedicineStock.findOne({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        hospitalId: admission.hospitalId,
        medicineName: medicineName,
        medicineId: null, // Explicitly look for stocks without medicineId
        stockSource: 'EXTERNAL_PHARMACY',
      });
    }

    if (patientStock) {
      console.log('[DEBUG] Found existing patient stock, updating...');
      // Update existing stock
      patientStock.issuedQtyBaseUnits += quantity;
      patientStock.currentBalanceBaseUnits += quantity;
      patientStock.receiptAcknowledged = true;
      patientStock.receiptAcknowledgedAt = operationNow();
      patientStock.receiptAcknowledgedBy = req.user?._id;
      patientStock.stockSource = 'EXTERNAL_PHARMACY';
      patientStock.lastIssuedAt = operationNow();
      patientStock.externalProvenance = { sourceType, receivedFrom, batchNumber, expiryDate: expiryDate ? new Date(expiryDate) : undefined, manufacturer, referenceNumber, verificationNote, verifiedBy: req.user?._id, receivedAt: operationNow() };

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
        hospitalId: admission.hospitalId,
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
        receiptAcknowledgedAt: operationNow(),
        receiptAcknowledgedBy: req.user?._id,
        stockSource: 'EXTERNAL_PHARMACY',
        lastIssuedAt: operationNow(),
        externalProvenance: { sourceType, receivedFrom, batchNumber, expiryDate: expiryDate ? new Date(expiryDate) : undefined, manufacturer, referenceNumber, verificationNote, verifiedBy: req.user?._id, receivedAt: operationNow() }
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
    medication.pharmacyRequest.requestedAt = medication.pharmacyRequest.requestedAt || operationNow();
    medication.pharmacyRequest.requestedBy = medication.pharmacyRequest.requestedBy || req.user?._id;
    // External/patient-supplied medicine is bedside stock, not a hospital
    // pharmacy dispense or sale. Keep that distinction explicit so pharmacy
    // revenue, pending-indent and return workflows do not pick it up.
    medication.pharmacyRequest.requestedQuantity = 0;
    medication.pharmacyRequest.pharmacyStatus = 'Delivered';
    medication.pharmacyRequest.dispensedFromPharmacy = false;
    medication.pharmacyRequest.dispensedQuantity = 0;
    medication.pharmacyRequest.saleId = null;
    medication.pharmacyRequest.dispensedAt = null;
    medication.pharmacyRequest.pharmacyNotes = `External/patient-supplied stock received from ${String(receivedFrom).trim()}`;
    medication.pharmacyRequest.stockReceivedByNurse = true;
    medication.pharmacyRequest.stockReceivedAt = operationNow();
    medication.pharmacyRequest.stockReceivedBy = req.user?._id;

    await medication.save();

    const externalStockActor = await resolveClinicalActor(req.user);
    await NursingNote.create({
      hospitalId: admission.hospitalId,
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      ...(externalStockActor.staffModel === 'Nurse' && externalStockActor.staffProfileId ? { nurseId: externalStockActor.staffProfileId } : {}),
      actorUserId: externalStockActor.userId,
      actorRole: externalStockActor.role,
      actorNameSnapshot: externalStockActor.name,
      noteType: 'Medication',
      note: `Received ${quantity} base unit(s) of ${medicineName} from external/patient-supplied stock (${sourceType}). Source: ${receivedFrom}. ${medicineId ? 'Mapped to medicine ID: ' + medicineId : 'NLEM medicine (not in inventory)'}. Stock is available for administration and is not hospital-pharmacy revenue.`,
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
    const status = ['ValidationError','CastError'].includes(err?.name) ? 400 : Number(err?.statusCode || 500);
    res.status(status).json({ 
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

    const stocks = await IPDPatientMedicineStock.find({ hospitalId: admission.hospitalId, admissionId })
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
  changeMedicationOrder: exports.changeMedicationOrder,
  addToPatientMedicineStock,
  deductFromPatientMedicineStock
};