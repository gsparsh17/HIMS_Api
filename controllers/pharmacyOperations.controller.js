const mongoose = require('mongoose');
const HospitalPharmacySetting = require('../models/HospitalPharmacySetting');
const Pharmacy = require('../models/Pharmacy');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Sale = require('../models/Sale');
const PurchaseOrder = require('../models/PurchaseOrder');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const InventoryLedger = require('../models/InventoryLedger');
const IPDPatientMedicineStock = require('../models/IPDPatientMedicineStock');
const PharmacyReturn = require('../models/PharmacyReturn');
const Prescription = require('../models/Prescription');
const Patient = require('../models/Patient');
const {
  objectIdOrUndefined,
  getHospitalId,
  getCreatedBy,
  normalizeMoney,
  getAdvanceBalance,
  createAdvanceLedgerEntry,
  buildSaleItems,
  calculateTotals,
  calculateRequiredBaseUnits,
  createUnifiedSale,
  createReturn
} = require('../services/pharmacyTransaction.service');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function getDefaultPharmacyId() {
  const pharmacy = await Pharmacy.findOne({ status: 'Active' }).select('_id');
  return pharmacy?._id;
}

exports.getSettings = asyncHandler(async (req, res) => {
  const hospitalId = getHospitalId(req);
  const pharmacyId = objectIdOrUndefined(req.query.pharmacyId) || await getDefaultPharmacyId();
  let settings = await HospitalPharmacySetting.findOne({ hospitalId, pharmacyId });

  if (!settings) {
    settings = await HospitalPharmacySetting.create({ hospitalId, pharmacyId });
  }

  res.json({ success: true, settings });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const hospitalId = getHospitalId(req, req.body.hospitalId);
  const pharmacyId = objectIdOrUndefined(req.body.pharmacyId || req.query.pharmacyId) || await getDefaultPharmacyId();
  const allowed = [
    'ipdAdvanceMode',
    'allowNegativeIpdPharmacyBalance',
    'defaultIpdBillingMode',
    'allowCashRefundOnReturn',
    'allowLooseTabletSale',
    'requireReturnApproval',
    'maxDiscountPercentWithoutApproval'
  ];

  const update = { updatedBy: getCreatedBy(req) };
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }

  const settings = await HospitalPharmacySetting.findOneAndUpdate(
    { hospitalId, pharmacyId },
    { $set: update, $setOnInsert: { hospitalId, pharmacyId } },
    { new: true, upsert: true }
  );

  res.json({ success: true, settings });
});

exports.quoteSale = asyncHandler(async (req, res) => {
  const items = await buildSaleItems(req.body.items || [], { honorLooseSale: req.body.allowLooseSale !== false });
  const totals = calculateTotals(items, req.body);

  const quoteItems = items.map(({ _batch, _medicine, ...item }) => ({
    ...item,
    stock_after_issue: Number((_batch.quantity_base_units ?? _batch.quantity ?? 0) - item.quantity_base_units),
    expiry_date: _batch.expiry_date,
    medicine: {
      _id: _medicine._id,
      name: _medicine.name,
      base_unit: _medicine.base_unit,
      pack_unit: _medicine.pack_unit,
      units_per_pack: _medicine.units_per_pack,
      allow_loose_sale: _medicine.allow_loose_sale
    }
  }));

  res.json({ success: true, items: quoteItems, totals });
});

exports.createSale = asyncHandler(async (req, res) => {
  const result = await createUnifiedSale(req.body, req);
  res.status(201).json({ success: true, message: 'Pharmacy sale completed', ...result });
});

exports.depositAdvance = asyncHandler(async (req, res) => {
  const hospitalId = getHospitalId(req, req.body.hospitalId);
  const pharmacyId = objectIdOrUndefined(req.body.pharmacyId || req.body.pharmacy_id) || await getDefaultPharmacyId();
  const patientId = objectIdOrUndefined(req.body.patientId || req.body.patient_id);
  const admissionId = objectIdOrUndefined(req.body.admissionId || req.body.admission_id);
  const amount = Number(req.body.amount || 0);

  if (!patientId || !admissionId) return res.status(400).json({ success: false, error: 'patientId and admissionId are required' });
  if (amount <= 0) return res.status(400).json({ success: false, error: 'Advance amount must be greater than zero' });

  const walletType = req.body.walletType || req.body.wallet_type || 'PHARMACY_IPD';
  const paymentMethod = req.body.paymentMethod || req.body.payment_method || 'Cash';
  const createdBy = getCreatedBy(req);

  const ledger = await createAdvanceLedgerEntry({
    hospitalId,
    patientId,
    admissionId,
    walletType,
    transactionType: 'ADVANCE_DEPOSIT',
    direction: 'CREDIT',
    amount,
    paymentMethod,
    referenceNumber: req.body.referenceNumber || req.body.reference_number,
    sourceModule: 'Pharmacy',
    notes: req.body.notes || 'IPD pharmacy advance received',
    createdBy
  });

  await PharmacyLedgerEntry.create({
    hospitalId,
    pharmacyId,
    entryType: 'ADVANCE_RECEIVED',
    direction: 'IN',
    amount: normalizeMoney(amount),
    paymentMethod,
    patientId,
    admissionId,
    notes: req.body.notes || `Advance received in ${walletType}`,
    createdBy
  });

  res.status(201).json({ success: true, ledger });
});

exports.getAdvanceLedger = asyncHandler(async (req, res) => {
  const admissionId = objectIdOrUndefined(req.params.admissionId);
  const walletType = req.query.walletType;
  const query = { admissionId };
  if (walletType) query.walletType = walletType;

  const ledgers = await PatientAdvanceLedger.find(query).sort({ createdAt: -1 }).lean();
  const sharedBalance = await getAdvanceBalance({ admissionId, walletType: 'IPD_SHARED' });
  const pharmacyBalance = await getAdvanceBalance({ admissionId, walletType: 'PHARMACY_IPD' });

  res.json({ success: true, balances: { IPD_SHARED: sharedBalance, PHARMACY_IPD: pharmacyBalance }, ledgers });
});

exports.getIPDQueue = asyncHandler(async (req, res) => {
  const { pharmacyId, search = '', limit = 100 } = req.query;
  const query = {
    requiresPharmacyDispense: true,
    'pharmacyRequest.requestedToPharmacy': true,
    'pharmacyRequest.pharmacyStatus': { $in: ['Pending', 'Approved'] }
  };
  if (pharmacyId && mongoose.Types.ObjectId.isValid(pharmacyId)) query['pharmacyRequest.pharmacyId'] = pharmacyId;

  const meds = await IPDMedicationChart.find(query)
    .populate('admissionId', 'admissionNumber status wardId bedId roomId')
    .populate('patientId', 'first_name last_name patientId uhid phone')
    .populate('prescribedBy', 'firstName lastName name')
    .populate('medicineId', 'name base_unit pack_unit units_per_pack allow_loose_sale')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();

  const queue = [];
  for (const med of meds) {
    const requiredQtyBaseUnits = calculateRequiredBaseUnits({
      dosage: med.dosage,
      frequency: med.frequency,
      duration: med.duration,
      durationUnit: med.durationUnit
    });

    const currentStock = med.admissionId?._id && med.medicineId?._id
      ? await IPDPatientMedicineStock.aggregate([
          { $match: { admissionId: med.admissionId._id, medicineId: med.medicineId._id } },
          { $group: { _id: null, balance: { $sum: '$currentBalanceBaseUnits' } } }
        ])
      : [];
    const patientBalanceBaseUnits = Number(currentStock[0]?.balance || 0);
    const suggestedIssueQtyBaseUnits = Math.max(0, requiredQtyBaseUnits - patientBalanceBaseUnits);
    const advanceBalances = med.admissionId?._id
      ? {
          IPD_SHARED: await getAdvanceBalance({ admissionId: med.admissionId._id, patientId: med.patientId?._id, walletType: 'IPD_SHARED' }),
          PHARMACY_IPD: await getAdvanceBalance({ admissionId: med.admissionId._id, patientId: med.patientId?._id, walletType: 'PHARMACY_IPD' })
        }
      : { IPD_SHARED: 0, PHARMACY_IPD: 0 };

    const searchable = [
      med.medicineName,
      med.patientId?.first_name,
      med.patientId?.last_name,
      med.patientId?.patientId,
      med.admissionId?.admissionNumber
    ].filter(Boolean).join(' ').toLowerCase();

    if (search && !searchable.includes(String(search).toLowerCase())) continue;

    queue.push({
      ...med,
      requiredQtyBaseUnits,
      patientBalanceBaseUnits,
      suggestedIssueQtyBaseUnits,
      advanceBalances
    });
  }

  res.json({ success: true, queue, total: queue.length });
});

exports.getAdmissionPharmacyFile = asyncHandler(async (req, res) => {
  const admissionId = objectIdOrUndefined(req.params.admissionId);
  const admission = await IPDAdmission.findById(admissionId)
    .populate('patientId', 'first_name last_name patientId uhid phone gender dob')
    .populate('primaryDoctorId', 'firstName lastName name')
    .populate('bedId roomId wardId')
    .lean();

  if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found' });

  const [medications, medicineStock, sales, returns, advanceLedgers, pharmacyLedgers] = await Promise.all([
    IPDMedicationChart.find({ admissionId }).populate('medicineId', 'name base_unit pack_unit units_per_pack').sort({ startDate: -1 }).lean(),
    IPDPatientMedicineStock.find({ admissionId }).populate('medicineId batchId').sort({ updatedAt: -1 }).lean(),
    Sale.find({ admission_id: admissionId }).populate('items.medicine_id items.batch_id').sort({ sale_date: -1 }).lean(),
    PharmacyReturn.find({ admissionId }).sort({ createdAt: -1 }).lean(),
    PatientAdvanceLedger.find({ admissionId }).sort({ createdAt: -1 }).lean(),
    PharmacyLedgerEntry.find({ admissionId }).sort({ entryDate: -1 }).lean()
  ]);

  const balances = {
    IPD_SHARED: await getAdvanceBalance({ admissionId, patientId: admission.patientId?._id, walletType: 'IPD_SHARED' }),
    PHARMACY_IPD: await getAdvanceBalance({ admissionId, patientId: admission.patientId?._id, walletType: 'PHARMACY_IPD' })
  };

  res.json({
    success: true,
    admission,
    balances,
    medications,
    medicineStock,
    sales,
    returns,
    advanceLedgers,
    pharmacyLedgers
  });
});

exports.getAdmissionMedicineStock = asyncHandler(async (req, res) => {
  const admissionId = objectIdOrUndefined(req.params.admissionId);
  const stock = await IPDPatientMedicineStock.find({ admissionId })
    .populate('medicineId', 'name base_unit pack_unit units_per_pack')
    .populate('batchId', 'batch_number expiry_date')
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ success: true, stock });
});

exports.dispenseIPDMedication = asyncHandler(async (req, res) => {
  const admissionId = objectIdOrUndefined(req.body.admissionId || req.body.admission_id);
  const patientId = objectIdOrUndefined(req.body.patientId || req.body.patient_id);

  if (!admissionId || !patientId) {
    return res.status(400).json({ success: false, error: 'admissionId and patientId are required' });
  }

  const items = [];
  for (const rawItem of req.body.items || []) {
    const medicationChartId = objectIdOrUndefined(rawItem.medicationChartId || rawItem.ipd_medication_chart_id);
    const med = medicationChartId ? await IPDMedicationChart.findById(medicationChartId).populate('medicineId') : null;
    const requested = rawItem.quantity_base_units || rawItem.quantityBaseUnits || rawItem.quantity;
    let requiredQty = requested != null ? Number(requested) : calculateRequiredBaseUnits({
      dosage: med?.dosage || rawItem.dosage,
      frequency: med?.frequency || rawItem.frequency,
      duration: med?.duration || rawItem.duration,
      durationUnit: med?.durationUnit || rawItem.durationUnit
    });

    if (req.body.deductExistingPatientStock !== false && med?.medicineId?._id) {
      const balances = await IPDPatientMedicineStock.aggregate([
        { $match: { admissionId, medicineId: med.medicineId._id } },
        { $group: { _id: null, balance: { $sum: '$currentBalanceBaseUnits' } } }
      ]);
      const patientBalance = Number(balances[0]?.balance || 0);
      requiredQty = Math.max(0, requiredQty - patientBalance);
    }

    if (requiredQty <= 0) continue;

    items.push({
      ...rawItem,
      medicine_id: rawItem.medicine_id || rawItem.medicineId || med?.medicineId?._id,
      medicine_name: rawItem.medicine_name || rawItem.medicineName || med?.medicineName || med?.medicineId?.name,
      quantity_base_units: requiredQty,
      ipd_medication_chart_id: medicationChartId
    });
  }

  if (items.length === 0) {
    return res.json({ success: true, message: 'No additional medicine issue needed because patient already has enough balance.', sale: null });
  }

  const result = await createUnifiedSale({
    ...req.body,
    items,
    patient_id: patientId,
    admission_id: admissionId,
    customer_type: 'IPD',
    source_type: 'IPD_MEDICATION'
  }, req);

  res.status(201).json({ success: true, message: 'IPD medication dispensed and synced', ...result });
});

exports.createReturn = asyncHandler(async (req, res) => {
  const pharmacyReturn = await createReturn(req.body, req);
  res.status(201).json({ success: true, message: 'Medicine return completed', return: pharmacyReturn });
});

exports.getReturns = asyncHandler(async (req, res) => {
  const { admissionId, patientId, startDate, endDate, limit = 50 } = req.query;
  const query = {};
  if (admissionId) query.admissionId = admissionId;
  if (patientId) query.patientId = patientId;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  const returns = await PharmacyReturn.find(query).sort({ createdAt: -1 }).limit(Number(limit)).lean();
  res.json({ success: true, returns });
});

exports.getLedgerDaily = asyncHandler(async (req, res) => {
  const start = req.query.startDate ? new Date(req.query.startDate) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = req.query.endDate ? new Date(req.query.endDate) : new Date(start);
  end.setHours(23, 59, 59, 999);

  const match = { entryDate: { $gte: start, $lte: end } };
  if (req.query.pharmacyId) match.pharmacyId = objectIdOrUndefined(req.query.pharmacyId);

  const [entries, summary] = await Promise.all([
    PharmacyLedgerEntry.find(match).populate('patientId', 'first_name last_name patientId').populate('admissionId', 'admissionNumber').sort({ entryDate: -1 }).lean(),
    PharmacyLedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: { paymentMethod: '$paymentMethod', direction: '$direction', entryType: '$entryType' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { '_id.paymentMethod': 1 } }
    ])
  ]);

  const totals = summary.reduce((acc, row) => {
    const key = `${row._id.direction}_${row._id.paymentMethod}`;
    acc[key] = normalizeMoney((acc[key] || 0) + row.amount);
    if (row._id.entryType === 'DISCOUNT') acc.discounts = normalizeMoney((acc.discounts || 0) + row.amount);
    if (row._id.entryType === 'REFUND') acc.refunds = normalizeMoney((acc.refunds || 0) + row.amount);
    return acc;
  }, {});

  res.json({ success: true, range: { start, end }, totals, summary, entries });
});

// Add these functions to the existing exports in pharmacyOperations.controller.js

// Get all active IPD patients with their pharmacy balances
exports.getIPDPatients = asyncHandler(async (req, res) => {
  const { search = '', status = 'Admitted,Under Treatment', limit = 100 } = req.query;
  const statusArray = status.split(',').map(s => s.trim());
  
  const query = {
    status: { $in: statusArray }
  };
  
  if (search) {
    const patients = await Patient.find({
      $or: [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        { patientId: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ]
    }).select('_id');
    
    query.patientId = { $in: patients.map(p => p._id) };
  }
  
  const admissions = await IPDAdmission.find(query)
    .populate('patientId', 'first_name last_name patientId phone age gender')
    .populate('bedId', 'bedNumber bedType')
    .populate('wardId', 'name')
    .populate('primaryDoctorId', 'firstName lastName')
    .sort({ admissionDate: -1 })
    .limit(Number(limit));
  
  // Get pharmacy balances for each admission
  const patientsWithBalances = await Promise.all(admissions.map(async (admission) => {
    const pharmacyAdvance = await getAdvanceBalance({ 
      admissionId: admission._id, 
      patientId: admission.patientId._id, 
      walletType: 'PHARMACY_IPD' 
    });
    
    const sharedIpdAdvance = await getAdvanceBalance({ 
      admissionId: admission._id, 
      patientId: admission.patientId._id, 
      walletType: 'IPD_SHARED' 
    });
    
    // Get recent pharmacy sales
    const recentSales = await Sale.find({ 
      admission_id: admission._id 
    }).sort({ sale_date: -1 }).limit(5);
    
    const totalSalesAmount = recentSales.reduce((sum, sale) => sum + sale.total_amount, 0);
    
    return {
      ...admission.toObject(),
      pharmacyAdvance,
      sharedIpdAdvance,
      recentSalesCount: recentSales.length,
      totalSalesAmount,
      lastSaleDate: recentSales[0]?.sale_date || null
    };
  }));
  
  res.json({ 
    success: true, 
    patients: patientsWithBalances,
    total: patientsWithBalances.length
  });
});

// Get patient's personal pharmacy ledger
exports.getPatientPharmacyLedger = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const { admissionId, startDate, endDate, limit = 50 } = req.query;
  
  const patient = await Patient.findById(patientId).select('first_name last_name patientId phone');
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }
  
  // Build query for admissions
  const admissionQuery = { patientId: patient._id };
  if (admissionId) {
    admissionQuery._id = admissionId;
  } else {
    admissionQuery.status = { $in: ['Admitted', 'Under Treatment', 'Discharge Initiated'] };
  }
  
  const admissions = await IPDAdmission.find(admissionQuery)
    .populate('bedId', 'bedNumber bedType')
    .populate('wardId', 'name')
    .sort({ admissionDate: -1 });
  
  // Get all pharmacy transactions (sales) for this patient
  const saleFilter = { patient_id: patient._id };
  if (startDate && endDate) {
    saleFilter.sale_date = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }
  
  const sales = await Sale.find(saleFilter)
    .populate('items.medicine_id', 'name')
    .populate('admission_id', 'admissionNumber')
    .sort({ sale_date: -1 })
    .limit(Number(limit));
  
  // Get advance ledger entries
  const advanceFilters = { patientId: patient._id };
  if (startDate && endDate) {
    advanceFilters.createdAt = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }
  
  const advanceLedgers = await PatientAdvanceLedger.find(advanceFilters)
    .sort({ createdAt: -1 })
    .limit(Number(limit));
  
  // Get pharmacy ledger entries
  const pharmacyLedgers = await PharmacyLedgerEntry.find({ patientId: patient._id })
    .sort({ entryDate: -1 })
    .limit(Number(limit));
  
  // Get medicine returns
  const returns = await PharmacyReturn.find({ patientId: patient._id })
    .sort({ createdAt: -1 })
    .limit(Number(limit));
  
  // Calculate current balances
  const currentBalances = {
    sharedIpdAdvance: 0,
    pharmacyAdvance: 0,
    totalSpent: 0,
    pendingBills: 0
  };
  
  for (const admission of admissions) {
    const pharmacyAdvance = await getAdvanceBalance({ 
      admissionId: admission._id, 
      patientId: patient._id, 
      walletType: 'PHARMACY_IPD' 
    });
    const sharedIpdAdvance = await getAdvanceBalance({ 
      admissionId: admission._id, 
      patientId: patient._id, 
      walletType: 'IPD_SHARED' 
    });
    
    currentBalances.pharmacyAdvance += pharmacyAdvance;
    currentBalances.sharedIpdAdvance += sharedIpdAdvance;
  }
  
  // Calculate total spent
  const allSales = await Sale.find({ patient_id: patient._id });
  currentBalances.totalSpent = allSales.reduce((sum, sale) => sum + sale.total_amount, 0);
  
  // Calculate pending bills (sales not fully paid)
  const pendingSales = await Sale.find({ 
    patient_id: patient._id,
    balance_due: { $gt: 0 }
  });
  currentBalances.pendingBills = pendingSales.reduce((sum, sale) => sum + sale.balance_due, 0);
  
  res.json({
    success: true,
    patient,
    admissions,
    transactions: {
      sales,
      advanceLedgers,
      pharmacyLedgers,
      returns
    },
    balances: currentBalances,
    summary: {
      totalSales: allSales.length,
      totalReturns: returns.length,
      lastTransaction: sales[0]?.sale_date || null
    }
  });
});

exports.getDashboard = asyncHandler(async (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const [salesAgg, ledgerAgg, pendingIpd, lowStockCount, nearExpiryCount, pendingPO, recentSales, recentReturns] = await Promise.all([
    Sale.aggregate([
      { $match: { sale_date: { $gte: start, $lte: end } } },
      { $group: { _id: '$customer_type', count: { $sum: 1 }, total: { $sum: '$total_amount' }, discount: { $sum: '$discount_amount' } } }
    ]),
    PharmacyLedgerEntry.aggregate([
      { $match: { entryDate: { $gte: start, $lte: end } } },
      { $group: { _id: { method: '$paymentMethod', direction: '$direction', type: '$entryType' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    IPDMedicationChart.countDocuments({ requiresPharmacyDispense: true, 'pharmacyRequest.requestedToPharmacy': true, 'pharmacyRequest.pharmacyStatus': 'Pending' }),
    MedicineBatch.countDocuments({ $expr: { $lte: ['$quantity_base_units', 10] }, is_active: true }),
    MedicineBatch.countDocuments({ expiry_date: { $gte: new Date(), $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, is_active: true }),
    PurchaseOrder.countDocuments({ status: { $in: ['Draft', 'Ordered', 'Partially Received'] } }),
    Sale.find({}).sort({ sale_date: -1 }).limit(10).populate('patient_id', 'first_name last_name patientId').lean(),
    PharmacyReturn.find({}).sort({ createdAt: -1 }).limit(10).lean()
  ]);

  const salesTotals = salesAgg.reduce((acc, row) => {
    acc.totalSales += row.count;
    acc.totalRevenue += row.total;
    acc.totalDiscounts += row.discount;
    acc.byType[row._id || 'Unknown'] = { count: row.count, total: normalizeMoney(row.total) };
    return acc;
  }, { totalSales: 0, totalRevenue: 0, totalDiscounts: 0, byType: {} });

  salesTotals.totalRevenue = normalizeMoney(salesTotals.totalRevenue);
  salesTotals.totalDiscounts = normalizeMoney(salesTotals.totalDiscounts);

  const ledger = ledgerAgg.reduce((acc, row) => {
    const key = `${row._id.direction}_${row._id.method}`;
    acc[key] = normalizeMoney((acc[key] || 0) + row.amount);
    return acc;
  }, {});

  res.json({
    success: true,
    today: {
      ...salesTotals,
      ledger,
      pendingIpd,
      lowStockCount,
      nearExpiryCount,
      pendingPurchaseOrders: pendingPO
    },
    recentSales,
    recentReturns
  });
});

exports.getInventoryAnalytics = asyncHandler(async (req, res) => {
  const batches = await MedicineBatch.find({ is_active: true }).populate('medicine_id', 'name category base_unit pack_unit units_per_pack min_stock_level_base_units').lean();
  const today = new Date();
  const nearExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const rows = batches.map(batch => {
    const qty = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    const value = normalizeMoney(qty * Number(batch.purchase_price_per_base_unit || (batch.purchase_price || 0) / (batch.units_per_pack || 1) || 0));
    const med = batch.medicine_id || {};
    return {
      batchId: batch._id,
      medicineId: med._id,
      medicineName: med.name,
      category: med.category,
      batchNumber: batch.batch_number,
      expiryDate: batch.expiry_date,
      quantityBaseUnits: qty,
      baseUnit: med.base_unit,
      packUnit: med.pack_unit,
      unitsPerPack: batch.units_per_pack || med.units_per_pack || 1,
      value,
      lowStock: qty <= Number(med.min_stock_level_base_units || 10),
      expired: batch.expiry_date < today,
      nearExpiry: batch.expiry_date >= today && batch.expiry_date <= nearExpiryDate
    };
  });

  const totals = rows.reduce((acc, row) => {
    acc.stockValue += row.value;
    if (row.lowStock) acc.lowStock += 1;
    if (row.expired) acc.expired += 1;
    if (row.nearExpiry) acc.nearExpiry += 1;
    return acc;
  }, { stockValue: 0, lowStock: 0, expired: 0, nearExpiry: 0, batches: rows.length });
  totals.stockValue = normalizeMoney(totals.stockValue);

  res.json({ success: true, totals, rows });
});

exports.getPurchaseAnalytics = asyncHandler(async (req, res) => {
  const start = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = req.query.endDate ? new Date(req.query.endDate) : new Date();

  const [byStatus, bySupplier, recent] = await Promise.all([
    PurchaseOrder.aggregate([{ $match: { order_date: { $gte: start, $lte: end } } }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$total_amount' } } }]),
    PurchaseOrder.aggregate([{ $match: { order_date: { $gte: start, $lte: end } } }, { $group: { _id: '$supplier_id', count: { $sum: 1 }, amount: { $sum: '$total_amount' } } }, { $sort: { amount: -1 } }, { $limit: 10 }]),
    PurchaseOrder.find({}).populate('supplier_id', 'name').sort({ order_date: -1 }).limit(10).lean()
  ]);

  res.json({ success: true, range: { start, end }, byStatus, bySupplier, recent });
});

exports.getInventoryLedger = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.medicineId) query.medicineId = objectIdOrUndefined(req.query.medicineId);
  if (req.query.batchId) query.batchId = objectIdOrUndefined(req.query.batchId);
  const entries = await InventoryLedger.find(query).populate('medicineId', 'name').populate('batchId', 'batch_number').sort({ createdAt: -1 }).limit(Number(req.query.limit || 100)).lean();
  res.json({ success: true, entries });
});

exports.searchIPDAdmissions = asyncHandler(async (req, res) => {
  const { q = '', limit = 20 } = req.query;
  const text = String(q).trim();
  const admissionQuery = text
    ? { admissionNumber: { $regex: text, $options: 'i' }, status: { $ne: 'Discharged' } }
    : { status: { $ne: 'Discharged' } };

  const admissions = await IPDAdmission.find(admissionQuery)
    .populate('patientId', 'first_name last_name patientId uhid phone')
    .sort({ admissionDate: -1 })
    .limit(Number(limit))
    .lean();

  res.json({ success: true, admissions });
});

exports.getDoseCalculation = asyncHandler(async (req, res) => {
  const requiredQtyBaseUnits = calculateRequiredBaseUnits(req.query);
  res.json({ success: true, requiredQtyBaseUnits });
});
