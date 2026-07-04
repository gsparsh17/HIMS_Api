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
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const IPDCharge = require('../models/IPDCharge');
const Hospital = require('../models/Hospital');
const Doctor = require('../models/Doctor');
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
  createReturn,
  createOutstandingSettlement,
  getPatientOutstanding,
  getPatientPharmacySummary
} = require('../services/pharmacyTransaction.service');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function canViewPharmacyCost(req) {
  const role = String(req.user?.role || req.user?.userType || '').toLowerCase();
  return ['admin', 'superadmin', 'pharmacy_head', 'pharmacyhead', 'pharmacy-admin', 'pharmacy_admin'].includes(role) || req.query.includeCost === 'true';
}

function stripCostFields(doc) {
  const clone = JSON.parse(JSON.stringify(doc));
  delete clone.total_purchase_cost;
  delete clone.gross_profit;
  delete clone.commission_amount;
  if (Array.isArray(clone.items)) {
    clone.items = clone.items.map(item => {
      delete item.purchase_rate_per_base_unit;
      delete item.purchase_amount;
      delete item.gross_profit;
      delete item.commission_amount;
      return item;
    });
  }
  return clone;
}

async function getDefaultPharmacyId() {
  const pharmacy = await Pharmacy.findOne({ status: 'Active' }).select('_id');
  return pharmacy?._id;
}

// ========== EXISTING FUNCTIONS (kept as is) ==========

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

exports.searchPharmacyPatients = asyncHandler(async (req, res) => {
  const { q = '', patientType = 'all', limit = 20 } = req.query;
  const text = String(q).trim();
  if (text.length < 2) return res.json({ success: true, patients: [] });

  const patientMatch = {
    $or: [
      { first_name: { $regex: text, $options: 'i' } },
      { middle_name: { $regex: text, $options: 'i' } },
      { last_name: { $regex: text, $options: 'i' } },
      { patientId: { $regex: text, $options: 'i' } },
      { uhid: { $regex: text, $options: 'i' } },
      { phone: { $regex: text, $options: 'i' } }
    ]
  };

  const patients = await Patient.find(patientMatch)
    .select('salutation first_name middle_name last_name patientId uhid phone gender dob patient_type')
    .limit(Number(limit))
    .lean();

  const activeAdmissions = await IPDAdmission.find({
    status: { $nin: ['Discharged', 'Cancelled'] },
    $or: [
      { admissionNumber: { $regex: text, $options: 'i' } },
      { shipNo: { $regex: text, $options: 'i' } },
      { patientId: { $in: patients.map(p => p._id) } }
    ]
  })
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone gender dob')
    .populate('primaryDoctorId', 'firstName lastName name')
    .populate('bedId', 'bedNumber bedType')
    .populate('wardId', 'name')
    .limit(Number(limit))
    .lean();

  const seen = new Set();
  const rows = [];

  for (const admission of activeAdmissions) {
    const patient = admission.patientId;
    if (!patient) continue;
    const key = `ipd-${admission._id}`;
    seen.add(String(patient._id));
    const balances = await getPatientPharmacySummary({ patientId: patient._id, admissionId: admission._id });
    rows.push({
      type: 'IPD',
      patient,
      admission,
      uhid: patient.uhid || patient.patientId,
      registrationNumber: admission.admissionNumber,
      shipNo: admission.shipNo || admission.admissionNumber,
      sponsorType: admission.paymentType || 'Self',
      doctor: admission.primaryDoctorId,
      balances,
      key
    });
  }

  if (patientType !== 'ipd') {
    for (const patient of patients) {
      if (seen.has(String(patient._id)) && patientType === 'all') continue;
      const balances = await getPatientPharmacySummary({ patientId: patient._id });
      rows.push({
        type: patient.patient_type === 'ipd' ? 'IPD_HISTORY' : 'OPD',
        patient,
        admission: null,
        uhid: patient.uhid || patient.patientId,
        registrationNumber: patient.patientId,
        shipNo: null,
        sponsorType: 'Self',
        doctor: null,
        balances,
        key: `patient-${patient._id}`
      });
    }
  }

  res.json({ success: true, patients: rows.slice(0, Number(limit)) });
});

exports.getSaleBill = asyncHandler(async (req, res) => {
  const withCosts = canViewPharmacyCost(req);
  let query = Sale.findById(req.params.saleId)
    .populate('patient_id', 'salutation first_name middle_name last_name patientId uhid phone gender dob')
    .populate('admission_id', 'admissionNumber status paymentType advanceAmount')
    .populate('doctor_id', 'firstName lastName name')
    .populate('items.medicine_id', 'name composition generic_name brand hsn_code gst_rate')
    .populate('items.batch_id', 'batch_number expiry_date')
    .populate('return_refs.return_id', 'returnNumber totalRefundAmount refundMode createdAt');

  const userRole = String(req.user?.role || req.user?.userType || '').toLowerCase();
  const canViewCost = ['admin', 'superadmin', 'pharmacy_head', 'pharmacyhead', 'pharmacy-admin', 'pharmacy_admin'].includes(userRole) || req.query.includeCost === 'true';

  if (canViewCost) {
    query = query.select('+total_purchase_cost +gross_profit +commission_amount +items.purchase_rate_per_base_unit +items.purchase_amount +items.gross_profit +items.commission_amount');
  }

  const sale = await query.lean();
  if (!sale) return res.status(404).json({ success: false, error: 'Sale bill not found' });

  const bill = await Bill.findOne({ sale_id: sale._id }).lean();
  const invoice = await Invoice.findOne({ sale_id: sale._id }).lean();

  let totalPurchaseCost = 0;
  let totalGrossProfit = 0;

  if (sale.items && sale.items.length > 0) {
    totalPurchaseCost = sale.items.reduce((sum, item) => {
      const purchaseAmount = item.purchase_amount || (item.purchase_rate_per_base_unit * (item.quantity_base_units || 0));
      return sum + Number(purchaseAmount || 0);
    }, 0);

    totalGrossProfit = sale.items.reduce((sum, item) => {
      const netAmount = item.net_amount || item.total_price || 0;
      const purchaseAmount = item.purchase_amount || (item.purchase_rate_per_base_unit * (item.quantity_base_units || 0));
      return sum + (Number(netAmount || 0) - Number(purchaseAmount || 0));
    }, 0);
  }

  const balances = await getPatientPharmacySummary({ patientId: sale.patient_id?._id || sale.patient_id, admissionId: sale.admission_id?._id || sale.admission_id });

  res.json({
    success: true,
    sale: canViewCost ? sale : stripCostFields(sale),
    bill,
    invoice,
    balances,
    costVisible: canViewCost,
    purchaseSummary: {
      totalPurchaseCost,
      totalGrossProfit,
      grossProfitMargin: totalPurchaseCost > 0 ? (totalGrossProfit / totalPurchaseCost * 100) : 0,
      itemCount: sale.items?.length || 0
    }
  });
});

exports.settleOutstanding = asyncHandler(async (req, res) => {
  const result = await createOutstandingSettlement(req.body, req);
  res.status(201).json({ success: true, message: 'Outstanding settlement completed', ...result });
});

exports.getAdmissionFinalClearance = asyncHandler(async (req, res) => {
  const admissionId = objectIdOrUndefined(req.params.admissionId || req.query.admissionId);
  if (!admissionId) return res.status(400).json({ success: false, error: 'admissionId is required' });

  const admission = await IPDAdmission.findById(admissionId)
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone gender dob age')
    .populate('primaryDoctorId', 'firstName lastName name specialization')
    .populate({
      path: 'bedId',
      select: 'bedNumber bedType dailyCharge status'
    })
    .populate({
      path: 'wardId',
      select: 'name floor type'
    })
    .populate({
      path: 'roomId',
      select: 'room_number type'
    })
    .lean();

  if (!admission) return res.status(404).json({ success: false, error: 'Admission not found' });

  const patientId = admission.patientId?._id || admission.patientId;

  const [sales, returns, ledgers, bills, invoices, deferredSales] = await Promise.all([
    Sale.find({ admission_id: admissionId }).sort({ sale_date: 1 }).lean(),
    PharmacyReturn.find({ admissionId }).sort({ createdAt: 1 }).lean(),
    PharmacyLedgerEntry.find({ admissionId }).sort({ entryDate: 1 }).lean(),
    Bill.find({ admission_id: admissionId, is_pharmacy_bill: true }).sort({ generated_at: 1 }).lean(),
    Invoice.find({ admission_id: admissionId, is_pharmacy_sale: true }).sort({ issue_date: 1 }).lean(),
    Sale.find({ admission_id: admissionId, payment_deferred: true, status: 'Pending' }).lean()
  ]);

  const balances = {
    IPD_SHARED: await getAdvanceBalance({ admissionId, patientId, walletType: 'IPD_SHARED' }),
    PHARMACY_IPD: await getAdvanceBalance({ admissionId, patientId, walletType: 'PHARMACY_IPD' })
  };

  const totalSpent = sales.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0);
  const totalPaid = sales.reduce((sum, sale) => sum + Number(sale.amount_paid || 0), 0);
  const totalReturnsAmount = returns.reduce((sum, ret) => sum + Number(ret.totalRefundAmount || 0), 0);

  const nonDeferredSales = sales.filter(s => !s.payment_deferred);
  const deferredSalesList = sales.filter(s => s.payment_deferred === true);

  const totalDeferredAmount = deferredSalesList.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0);
  const totalDeferredPaid = deferredSalesList.reduce((sum, sale) => sum + Number(sale.amount_paid || 0), 0);
  const totalDeferredReturns = deferredSalesList.reduce((sum, sale) => sum + Number(sale.return_amount || 0), 0);

  const totalNonDeferred = nonDeferredSales.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0);
  const totalNonDeferredPaid = nonDeferredSales.reduce((sum, sale) => sum + Number(sale.amount_paid || 0), 0);
  const totalNonDeferredReturns = nonDeferredSales.reduce((sum, sale) => sum + Number(sale.return_amount || 0), 0);

  const nonDeferredRemaining = Math.max(0, totalNonDeferred - totalNonDeferredPaid - totalNonDeferredReturns);
  const deferredRemaining = Math.max(0, totalDeferredAmount - totalDeferredPaid - totalDeferredReturns);

  const pharmacyAdvance = balances.PHARMACY_IPD;
  const advanceUsedForDeferred = Math.min(pharmacyAdvance, deferredRemaining);
  const remainingAdvanceAfterDeferred = Math.max(0, pharmacyAdvance - advanceUsedForDeferred);
  const advanceUsedForNonDeferred = Math.min(remainingAdvanceAfterDeferred, nonDeferredRemaining);
  const totalAdvanceUsed = advanceUsedForDeferred + advanceUsedForNonDeferred;
  const outstanding = Math.max(0, nonDeferredRemaining - advanceUsedForNonDeferred);
  const refundableAdvance = Math.max(0, pharmacyAdvance - totalAdvanceUsed);
  const pendingBillsTotal = sales.reduce((sum, s) => sum + (s.balance_due || 0), 0);

  let totalPurchaseCost = 0;
  let totalGrossProfit = 0;
  let totalItems = 0;

  sales.forEach(sale => {
    if (sale.items && Array.isArray(sale.items)) {
      sale.items.forEach(item => {
        totalItems++;
        const quantity = item.quantity_base_units || item.quantity || 0;
        const purchaseRate = item.purchase_rate_per_base_unit || item.purchaseRatePerBaseUnit || 0;
        const purchaseAmount = item.purchase_amount || item.purchaseAmount || (purchaseRate * quantity);
        totalPurchaseCost += purchaseAmount;
      });
    }
    if (sale.total_purchase_cost) {
      totalPurchaseCost = Math.max(totalPurchaseCost, Number(sale.total_purchase_cost) || 0);
    }
  });

  totalGrossProfit = Math.max(0, totalSpent - totalPurchaseCost);

  const billRows = sales.map(sale => {
    let salePurchaseCost = 0;
    let saleGrossProfit = 0;
    let saleItemsCount = 0;

    if (sale.items && Array.isArray(sale.items)) {
      sale.items.forEach(item => {
        saleItemsCount++;
        const quantity = item.quantity_base_units || item.quantity || 0;
        const purchaseRate = item.purchase_rate_per_base_unit || item.purchaseRatePerBaseUnit || 0;
        const purchaseAmount = item.purchase_amount || item.purchaseAmount || (purchaseRate * quantity);
        salePurchaseCost += purchaseAmount;
      });
    }

    if (sale.total_purchase_cost) {
      salePurchaseCost = Math.max(salePurchaseCost, Number(sale.total_purchase_cost) || 0);
    }

    saleGrossProfit = Math.max(0, Number(sale.total_amount || 0) - salePurchaseCost);

    return {
      billType: sale.payment_deferred ? 'DEFERRED' : 'SALE',
      billNumber: sale.sale_number,
      invoiceNumber: sale.invoice_number,
      date: sale.sale_date,
      grossAmount: sale.gross_amount || sale.subtotal,
      discount: (sale.item_discount_amount || 0) + (sale.discount_amount || 0),
      tax: sale.tax || 0,
      totalAmount: sale.total_amount || 0,
      paidAmount: sale.amount_paid || 0,
      returnAmount: sale.return_amount || 0,
      balanceDue: sale.balance_due || 0,
      closingOutstanding: sale.closing_outstanding || 0,
      paymentMethod: sale.payment_method,
      isDeferred: sale.payment_deferred === true,
      deferralReason: sale.deferral_reason,
      purchaseCost: salePurchaseCost,
      grossProfit: saleGrossProfit,
      profitMargin: salePurchaseCost > 0 ? (saleGrossProfit / salePurchaseCost * 100) : 0,
      itemCount: saleItemsCount,
      items: (sale.items || []).map(item => ({
        medicine_name: item.medicine_name,
        composition: item.composition,
        quantity: item.quantity_base_units,
        unit_price: item.unit_price,
        amount: item.net_amount,
        batch_number: item.batch_number,
        expiry_date: item.expiry_date,
        tax_rate: item.tax_rate,
        purchase_rate_per_base_unit: item.purchase_rate_per_base_unit || item.purchaseRatePerBaseUnit || 0,
        purchase_amount: item.purchase_amount || item.purchaseAmount || 0,
        gross_profit: (item.net_amount || item.total_price || 0) - (item.purchase_amount || item.purchaseRatePerBaseUnit || 0)
      }))
    };
  });

  const returnRows = returns.map(ret => ({
    billType: 'RETURN',
    billNumber: ret.returnNumber,
    originalBillNumber: ret.originalSaleNumber,
    date: ret.createdAt,
    refundMode: ret.refundMode,
    totalRefundAmount: ret.totalRefundAmount || 0,
    items: ret.items || []
  }));

  const summary = {
    totalSales: normalizeMoney(totalSpent),
    totalReturns: normalizeMoney(totalReturnsAmount),
    totalPaid: normalizeMoney(totalPaid),
    totalDue: normalizeMoney(outstanding),
    totalDeferred: normalizeMoney(totalDeferredAmount),
    pharmacyAdvanceBalance: normalizeMoney(pharmacyAdvance),
    sharedIpdAdvanceBalance: normalizeMoney(balances.IPD_SHARED),
    netPayableBeforeDischarge: normalizeMoney(outstanding + deferredRemaining),
    refundableAdvance: normalizeMoney(refundableAdvance),
    deferredRemaining: normalizeMoney(deferredRemaining),
    nonDeferredRemaining: normalizeMoney(nonDeferredRemaining),
    advanceUsedForDeferred: normalizeMoney(advanceUsedForDeferred),
    advanceUsedForNonDeferred: normalizeMoney(advanceUsedForNonDeferred),
    totalAdvanceUsed: normalizeMoney(totalAdvanceUsed),
    totalPurchaseCost: normalizeMoney(totalPurchaseCost),
    totalGrossProfit: normalizeMoney(totalGrossProfit),
    profitMargin: totalPurchaseCost > 0 ? (totalGrossProfit / totalPurchaseCost * 100) : 0,
    totalItems: totalItems
  };

  const formattedBalances = {
    IPD_SHARED: balances.IPD_SHARED,
    PHARMACY_IPD: balances.PHARMACY_IPD,
    outstanding: outstanding,
    totalSpent: totalSpent,
    pendingBills: pendingBillsTotal,
    sharedIpdAdvance: balances.IPD_SHARED,
    pharmacyAdvance: balances.PHARMACY_IPD,
    deferredAmount: totalDeferredAmount,
    deferredCount: deferredSalesList.length,
    nonDeferredOutstanding: nonDeferredRemaining,
    deferredRemaining: deferredRemaining,
    refundableAdvance: refundableAdvance
  };

  const admissionWithDetails = {
    ...admission,
    ward_name: admission.wardId?.name || 'N/A',
    bed_number: admission.bedId?.bedNumber || 'N/A',
    bed_type: admission.bedId?.bedType || 'N/A',
    ward_type: admission.wardId?.type || 'N/A',
    room_number: admission.roomId?.room_number || 'N/A'
  };

  res.json({
    success: true,
    admission: admissionWithDetails,
    bills: billRows,
    returns: returnRows,
    ledgers,
    pharmacyBills: bills,
    pharmacyInvoices: invoices,
    deferredPayments: deferredSalesList,
    balances: formattedBalances,
    summary
  });
});

// ========== DEFERRED PAYMENTS ENDPOINTS ==========

exports.getDeferredPaymentsByAdmission = asyncHandler(async (req, res) => {
  const { admissionId } = req.params;

  if (!admissionId) {
    return res.status(400).json({ success: false, error: 'admissionId is required' });
  }

  const deferredSales = await Sale.find({
    admission_id: admissionId,
    include_in_discharge_clearance: true,
    status: { $ne: 'Cancelled' }
  })
    .select('+total_purchase_cost +gross_profit +commission_amount +items.purchase_rate_per_base_unit +items.purchase_amount +items.gross_profit +items.commission_amount')
    .populate('patient_id', 'first_name last_name patientId uhid phone')
    .populate('doctor_id', 'firstName lastName')
    .populate('items.medicine_id', 'name composition')
    .populate('items.batch_id', 'batch_number expiry_date')
    .sort({ sale_date: -1 })
    .lean();

  const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
  const saleIds = deferredSales.map(s => s._id);
  const bills = await Bill.find({ sale_id: { $in: saleIds }, is_pharmacy_bill: true }).lean();
  const invoices = await Invoice.find({ sale_id: { $in: saleIds }, is_pharmacy_sale: true }).lean();

  res.json({
    success: true,
    deferredPayments: deferredSales,
    totalDeferredAmount,
    deferredCount: deferredSales.length,
    bills,
    invoices
  });
});

exports.getAllDeferredPayments = asyncHandler(async (req, res) => {
  const { startDate, endDate, admissionId, patientId, limit = 100 } = req.query;

  const query = {
    payment_deferred: true,
    status: { $in: ['Pending', 'Partially Paid'] }
  };

  if (admissionId) query.admission_id = admissionId;
  if (patientId) query.patient_id = patientId;

  if (startDate || endDate) {
    query.sale_date = {};
    if (startDate) query.sale_date.$gte = new Date(startDate);
    if (endDate) query.sale_date.$lte = new Date(endDate);
  }

  const deferredSales = await Sale.find(query)
    .select('+total_purchase_cost +gross_profit +commission_amount +items.purchase_rate_per_base_unit +items.purchase_amount +items.gross_profit +items.commission_amount')
    .populate('patient_id', 'first_name last_name patientId uhid phone')
    .populate('admission_id', 'admissionNumber shipNumber status')
    .populate('doctor_id', 'firstName lastName')
    .populate('items.medicine_id', 'name composition')
    .sort({ sale_date: -1 })
    .limit(Number(limit))
    .lean();

  const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);

  res.json({
    success: true,
    deferredPayments: deferredSales,
    totalDeferredAmount,
    deferredCount: deferredSales.length
  });
});

exports.settleDeferredPayment = asyncHandler(async (req, res) => {
  const { saleId } = req.params;
  const {
    paymentMethod = 'Cash',
    reference,
    collected_by,
    discount = 0,
    discountType = 'percentage'
  } = req.body;

  const sale = await Sale.findById(saleId);
  if (!sale) {
    return res.status(404).json({ success: false, error: 'Sale not found' });
  }

  if (!sale.payment_deferred) {
    return res.status(400).json({ success: false, error: 'This sale is not a deferred payment' });
  }

  if (sale.status === 'Completed') {
    return res.status(400).json({ success: false, error: 'Sale is already completed' });
  }

  let amountToPay = sale.balance_due;
  let discountAmount = 0;

  if (discount > 0) {
    if (discountType === 'percentage') {
      discountAmount = normalizeMoney(amountToPay * (discount / 100));
    } else {
      discountAmount = normalizeMoney(Math.min(discount, amountToPay));
    }
    amountToPay = normalizeMoney(amountToPay - discountAmount);
  }

  const paidAmount = sale.amount_paid + amountToPay;

  sale.amount_paid = paidAmount;
  sale.balance_due = 0;
  sale.status = 'Completed';
  sale.payment_method = paymentMethod;
  sale.payment_deferred = false;
  sale.settled_at = new Date();

  if (discountAmount > 0) {
    sale.discount_amount = normalizeMoney((sale.discount_amount || 0) + discountAmount);
    sale.discount_reason = sale.discount_reason
      ? `${sale.discount_reason}; Settlement discount ₹${discountAmount}`
      : `Settlement discount ₹${discountAmount}`;
  }

  sale.payments = sale.payments || [];
  sale.payments.push({
    method: paymentMethod,
    amount: amountToPay,
    reference: reference,
    date: new Date(),
    collected_by: collected_by || getCreatedBy(req)
  });

  await sale.save();

  if (sale.invoice_id) {
    const invoice = await Invoice.findById(sale.invoice_id);
    if (invoice) {
      invoice.amount_paid = (invoice.amount_paid || 0) + amountToPay;
      invoice.balance_due = invoice.total - invoice.amount_paid;
      invoice.status = invoice.balance_due <= 0 ? 'Paid' : 'Partial';
      if (discountAmount > 0) {
        invoice.discount = (invoice.discount || 0) + discountAmount;
      }
      await invoice.save();
    }
  }

  if (sale.bill_id) {
    const bill = await Bill.findById(sale.bill_id);
    if (bill) {
      bill.paid_amount = (bill.paid_amount || 0) + amountToPay;
      bill.balance_due = bill.total_amount - bill.paid_amount;
      bill.status = bill.balance_due <= 0 ? 'Paid' : 'Partially Paid';
      if (discountAmount > 0) {
        bill.discount = (bill.discount || 0) + discountAmount;
        bill.discount_amount = (bill.discount_amount || 0) + discountAmount;
      }
      await bill.save();
    }
  }

  if (sale.patient_id) {
    await Patient.findByIdAndUpdate(sale.patient_id, {
      $inc: { pharmacy_outstanding_balance: -amountToPay }
    });
  }

  if (sale.admission_id && sale.patient_id) {
    const ipdCharge = await IPDCharge.findOne({
      admissionId: sale.admission_id,
      sourceId: sale._id,
      sourceModule: 'Pharmacy'
    });
    if (ipdCharge && !ipdCharge.isBilled) {
      ipdCharge.isBilled = true;
      ipdCharge.billedAt = new Date();
      await ipdCharge.save();
    }
  }

  await PharmacyLedgerEntry.create({
    hospitalId: sale.hospitalId,
    pharmacyId: sale.pharmacy_id,
    entryType: 'OUTSTANDING_PAYMENT',
    direction: 'IN',
    amount: amountToPay,
    paymentMethod: paymentMethod,
    patientId: sale.patient_id,
    admissionId: sale.admission_id,
    saleId: sale._id,
    invoiceId: sale.invoice_id,
    notes: `Deferred payment settled via ${paymentMethod}. Discount: ₹${discountAmount}. Reference: ${reference || 'N/A'}`,
    createdBy: collected_by || getCreatedBy(req)
  });

  if (discountAmount > 0) {
    await PharmacyLedgerEntry.create({
      hospitalId: sale.hospitalId,
      pharmacyId: sale.pharmacy_id,
      entryType: 'DISCOUNT',
      direction: 'NON_CASH',
      amount: discountAmount,
      paymentMethod: 'Discount',
      patientId: sale.patient_id,
      admissionId: sale.admission_id,
      saleId: sale._id,
      invoiceId: sale.invoice_id,
      notes: `Settlement discount applied to deferred payment ${sale.sale_number}`,
      createdBy: collected_by || getCreatedBy(req)
    });
  }

  res.json({
    success: true,
    message: 'Deferred payment settled successfully',
    sale: {
      _id: sale._id,
      sale_number: sale.sale_number,
      amount_paid: sale.amount_paid,
      balance_due: sale.balance_due,
      discount_applied: discountAmount,
      status: sale.status
    }
  });
});

exports.getDoctorCommissionReport = asyncHandler(async (req, res) => {
  const start = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
  const match = { sale_date: { $gte: start, $lte: end }, 'items.is_own_brand': true };
  if (req.query.doctorId) match.doctor_id = objectIdOrUndefined(req.query.doctorId);
  const sales = await Sale.find(match)
    .select('+commission_amount +items.commission_amount +items.purchase_amount +items.gross_profit')
    .populate('doctor_id', 'firstName lastName name')
    .sort({ sale_date: -1 })
    .lean();
  const rows = [];
  for (const sale of sales) {
    for (const item of sale.items || []) {
      if (!item.is_own_brand) continue;
      rows.push({
        saleNumber: sale.sale_number,
        saleDate: sale.sale_date,
        patientName: sale.customer_name,
        doctorId: item.doctor_id || sale.doctor_id?._id || sale.doctor_id,
        doctorName: item.doctor_name || sale.doctor_name || sale.doctor_id?.name || [sale.doctor_id?.firstName, sale.doctor_id?.lastName].filter(Boolean).join(' '),
        medicineName: item.medicine_name,
        brand: item.brand,
        quantity: item.quantity_base_units || item.quantity,
        taxableAmount: item.taxable_amount || 0,
        commissionType: item.commission_type,
        commissionValue: item.commission_value,
        commissionAmount: item.commission_amount || 0
      });
    }
  }
  const totals = rows.reduce((acc, row) => {
    acc.salesAmount += Number(row.taxableAmount || 0);
    acc.commissionAmount += Number(row.commissionAmount || 0);
    return acc;
  }, { salesAmount: 0, commissionAmount: 0, rows: rows.length });
  totals.salesAmount = normalizeMoney(totals.salesAmount);
  totals.commissionAmount = normalizeMoney(totals.commissionAmount);
  res.json({ success: true, range: { start, end }, totals, rows });
});

exports.getDoctorBillReport = asyncHandler(async (req, res) => {
  const start = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = req.query.endDate ? new Date(req.query.endDate) : new Date();

  const match = {
    sale_date: { $gte: start, $lte: end }
  };

  if (req.query.doctorId) {
    match.doctor_id = objectIdOrUndefined(req.query.doctorId);
  }

  const sales = await Sale.find(match)
    .populate({
      path: 'patient_id',
      select: 'first_name last_name patientId uhid phone age gender'
    })
    .populate({
      path: 'doctor_id',
      select: 'firstName lastName name specialization'
    })
    .populate({
      path: 'admission_id',
      select: 'admissionNumber shipNumber'
    })
    .populate({
      path: 'items.medicine_id',
      select: 'name composition generic_name brand hsn_code gst_rate'
    })
    .populate({
      path: 'items.batch_id',
      select: 'batch_number expiry_date purchase_price_per_base_unit purchase_price purchase_price_per_pack units_per_pack'
    })
    .sort({ sale_date: -1 })
    .lean();

  const rows = [];
  let totalSales = 0;
  let totalPurchaseCost = 0;
  let totalGrossProfit = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let totalItems = 0;

  for (const sale of sales) {
    const [bill, invoice] = await Promise.all([
      Bill.findOne({ sale_id: sale._id }).lean(),
      Invoice.findOne({ sale_id: sale._id }).lean()
    ]);

    let salePurchaseCost = 0;
    let saleGrossProfit = 0;

    const itemsWithCost = (sale.items || []).map(item => {
      const quantity = item.quantity_base_units || item.quantity || 0;

      let purchaseRate = 0;

      if (item.purchase_rate_per_base_unit) {
        purchaseRate = item.purchase_rate_per_base_unit;
      } else if (item.purchase_amount) {
        purchaseRate = item.purchase_amount / (quantity > 0 ? quantity : 1);
      } else if (item.batch_id?.purchase_price_per_base_unit) {
        purchaseRate = item.batch_id.purchase_price_per_base_unit;
      } else if (item.batch_id?.purchase_price_per_pack && item.batch_id?.units_per_pack) {
        purchaseRate = item.batch_id.purchase_price_per_pack / item.batch_id.units_per_pack;
      } else if (item.batch_id?.purchase_price) {
        const unitsPerPack = item.batch_id?.units_per_pack || 1;
        purchaseRate = item.batch_id.purchase_price / unitsPerPack;
      }

      let purchaseAmount = item.purchase_amount || (purchaseRate * quantity);
      const netAmount = item.net_amount || item.total_price || 0;
      const profit = netAmount - purchaseAmount;

      if (!item.is_return && item.item_type !== 'Medicine Return') {
        salePurchaseCost += purchaseAmount > 0 ? purchaseAmount : 0;
        saleGrossProfit += profit;
      }

      return {
        ...item,
        purchase_rate_per_base_unit: purchaseRate,
        purchase_amount: purchaseAmount,
        profit: profit,
        profit_margin: purchaseAmount > 0 ? (profit / purchaseAmount * 100) : 0,
        medicine_name: item.medicine_name || item.medicine_id?.name || 'Unknown',
        composition: item.composition || item.medicine_id?.composition || '',
        batch_number: item.batch_number || item.batch_id?.batch_number || '—',
        unit_price: item.unit_price || item.rate_per_base_unit || 0,
        quantity_base_units: quantity
      };
    });

    if (salePurchaseCost === 0 && itemsWithCost.length > 0) {
      salePurchaseCost = itemsWithCost.reduce((sum, item) => {
        if (item.is_return || item.item_type === 'Medicine Return') return sum;
        return sum + (item.purchase_amount || 0);
      }, 0);

      saleGrossProfit = (sale.total_amount || 0) - salePurchaseCost;
    }

    if (saleGrossProfit === 0 && sale.total_amount > 0 && salePurchaseCost > 0) {
      saleGrossProfit = sale.total_amount - salePurchaseCost;
    }

    totalSales += sale.total_amount || 0;
    totalPurchaseCost += salePurchaseCost;
    totalGrossProfit += saleGrossProfit;
    totalDiscount += sale.discount_amount || 0;
    totalTax += sale.tax || 0;
    totalItems += sale.items?.length || 0;

    rows.push({
      saleId: sale._id,
      saleNumber: sale.sale_number,
      invoiceNumber: sale.invoice_number || invoice?.invoice_number || '—',
      billNumber: bill?.bill_number || '—',
      saleDate: sale.sale_date,
      patient: sale.patient_id ? {
        _id: sale.patient_id._id,
        name: `${sale.patient_id.first_name || ''} ${sale.patient_id.last_name || ''}`.trim(),
        uhid: sale.patient_id.uhid || sale.patient_id.patientId,
        phone: sale.patient_id.phone
      } : null,
      doctor: sale.doctor_id ? {
        _id: sale.doctor_id._id,
        name: sale.doctor_id.name || `${sale.doctor_id.firstName || ''} ${sale.doctor_id.lastName || ''}`.trim(),
        specialization: sale.doctor_id.specialization
      } : null,
      admission: sale.admission_id ? {
        _id: sale.admission_id._id,
        number: sale.admission_id.admissionNumber || sale.admission_id.shipNumber
      } : null,
      customerType: sale.customer_type || 'WalkIn',
      paymentMethod: sale.payment_method,
      isDeferred: sale.payment_deferred || false,
      deferralReason: sale.deferral_reason,
      subtotal: sale.subtotal || 0,
      discountAmount: sale.discount_amount || 0,
      taxAmount: sale.tax || 0,
      totalAmount: sale.total_amount || 0,
      paidAmount: sale.amount_paid || 0,
      balanceDue: sale.balance_due || 0,
      purchaseCost: salePurchaseCost,
      grossProfit: saleGrossProfit,
      profitMargin: salePurchaseCost > 0 ? (saleGrossProfit / salePurchaseCost * 100) : 0,
      items: itemsWithCost,
      itemCount: sale.items?.length || 0,
      bill: bill,
      invoice: invoice
    });
  }

  const summary = {
    totalSales: totalSales,
    totalPurchaseCost: totalPurchaseCost,
    totalGrossProfit: totalGrossProfit,
    totalDiscount: totalDiscount,
    totalTax: totalTax,
    totalItems: totalItems,
    totalBills: rows.length,
    totalPaid: rows.reduce((sum, r) => sum + r.paidAmount, 0),
    totalBalanceDue: rows.reduce((sum, r) => sum + r.balanceDue, 0),
    avgProfitMargin: totalPurchaseCost > 0 ? (totalGrossProfit / totalPurchaseCost * 100) : 0
  };

  res.json({
    success: true,
    range: { start, end },
    summary: summary,
    rows: rows,
    doctorFilter: req.query.doctorId || null
  });
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
    .populate('patientId', 'salutation first_name middle_name last_name patientId uhid phone gender dob age')
    .populate('primaryDoctorId', 'firstName lastName name specialization')
    .populate({
      path: 'bedId',
      select: 'bedNumber bedType dailyCharge status'
    })
    .populate({
      path: 'wardId',
      select: 'name floor type'
    })
    .populate({
      path: 'roomId',
      select: 'room_number type'
    })
    .lean();

  if (!admission) return res.status(404).json({ success: false, error: 'IPD admission not found' });

  const [medications, medicineStock, sales, returns, advanceLedgers, pharmacyLedgers, bills, invoices, deferredSales] = await Promise.all([
    IPDMedicationChart.find({ admissionId }).populate('medicineId', 'name base_unit pack_unit units_per_pack').sort({ startDate: -1 }).lean(),
    IPDPatientMedicineStock.find({ admissionId }).populate('medicineId batchId').sort({ updatedAt: -1 }).lean(),
    Sale.find({ admission_id: admissionId }).populate('items.medicine_id items.batch_id').sort({ sale_date: -1 }).lean(),
    PharmacyReturn.find({ admissionId }).sort({ createdAt: -1 }).lean(),
    PatientAdvanceLedger.find({ admissionId }).sort({ createdAt: -1 }).lean(),
    PharmacyLedgerEntry.find({ admissionId }).sort({ entryDate: -1 }).lean(),
    Bill.find({ admission_id: admissionId, is_pharmacy_bill: true }).sort({ generated_at: -1 }).lean(),
    Invoice.find({ admission_id: admissionId, is_pharmacy_sale: true }).sort({ issue_date: -1 }).lean(),
    Sale.find({ admission_id: admissionId, payment_deferred: true, status: 'Pending' }).sort({ sale_date: -1 }).lean()
  ]);

  const balances = {
    IPD_SHARED: await getAdvanceBalance({ admissionId, patientId: admission.patientId?._id, walletType: 'IPD_SHARED' }),
    PHARMACY_IPD: await getAdvanceBalance({ admissionId, patientId: admission.patientId?._id, walletType: 'PHARMACY_IPD' })
  };

  const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);

  res.json({
    success: true,
    admission,
    balances,
    medications,
    medicineStock,
    sales,
    returns,
    advanceLedgers,
    pharmacyLedgers,
    bills,
    invoices,
    deferredPayments: deferredSales,
    totalDeferredAmount
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

  const entries = await PharmacyLedgerEntry.find(match)
    .populate('patientId', 'first_name last_name patientId uhid phone age gender')
    .populate({
      path: 'admissionId',
      select: 'admissionNumber shipNumber bedId wardId roomId status',
      populate: [
        { path: 'bedId', select: 'bedNumber bedType dailyCharge' },
        { path: 'wardId', select: 'name floor type' },
        { path: 'roomId', select: 'room_number type' }
      ]
    })
    .populate({
      path: 'saleId',
      select: 'sale_number invoice_number total_amount'
    })
    .populate({
      path: 'invoiceId',
      select: 'invoice_number'
    })
    .populate({
      path: 'returnId',
      select: 'returnNumber totalRefundAmount'
    })
    .sort({ entryDate: -1 })
    .lean();

  const enrichedEntries = entries.map(entry => {
    let referenceNumber = null;
    if (entry.saleId) {
      referenceNumber = entry.saleId.sale_number || entry.saleId.invoice_number;
    } else if (entry.invoiceId) {
      referenceNumber = entry.invoiceId.invoice_number;
    } else if (entry.returnId) {
      referenceNumber = entry.returnId.returnNumber;
    }

    let wardName = null;
    let bedNumber = null;
    let wardId = null;
    let bedId = null;

    if (entry.admissionId) {
      wardName = entry.admissionId.wardId?.name || null;
      bedNumber = entry.admissionId.bedId?.bedNumber || null;
      wardId = entry.admissionId.wardId?._id || null;
      bedId = entry.admissionId.bedId?._id || null;
    }

    return {
      ...entry,
      saleNumber: entry.saleId?.sale_number || null,
      invoiceNumber: entry.invoiceId?.invoice_number || null,
      returnNumber: entry.returnId?.returnNumber || null,
      referenceNumber: referenceNumber,
      saleAmount: entry.saleId?.total_amount || null,
      wardName: wardName,
      bedNumber: bedNumber,
      wardId: wardId,
      bedId: bedId
    };
  });

  const billsQuery = {
    generated_at: { $gte: start, $lte: end },
    is_pharmacy_bill: true
  };

  const bills = await Bill.find(billsQuery)
    .populate('patient_id', 'first_name last_name patientId uhid phone age gender')
    .populate({
      path: 'admission_id',
      select: 'admissionNumber shipNumber bedId wardId roomId status',
      populate: [
        { path: 'bedId', select: 'bedNumber bedType dailyCharge' },
        { path: 'wardId', select: 'name floor type' },
        { path: 'roomId', select: 'room_number type' }
      ]
    })
    .populate({
      path: 'sale_id',
      select: 'sale_number invoice_number items total_amount gross_profit total_purchase_cost'
    })
    .populate('invoice_id', 'invoice_number')
    .populate('items.medicine_id', 'name composition')
    .sort({ generated_at: -1 })
    .lean();

  const enrichedBills = bills.map(bill => {
    let wardName = null;
    let bedNumber = null;
    let wardId = null;
    let bedId = null;
    let admissionNumber = null;

    if (bill.admission_id) {
      wardName = bill.admission_id.wardId?.name || null;
      bedNumber = bill.admission_id.bedId?.bedNumber || null;
      wardId = bill.admission_id.wardId?._id || null;
      bedId = bill.admission_id.bedId?._id || null;
      admissionNumber = bill.admission_id.admissionNumber || null;
    }

    let totalPurchaseCost = 0;
    let totalGrossProfit = 0;
    let totalGST = bill.tax_amount || bill.tax || 0;
    let enrichedItems = [];

    if (bill.sale_id && bill.sale_id.items && Array.isArray(bill.sale_id.items)) {
      const saleItems = bill.sale_id.items;

      for (const billItem of (bill.items || [])) {
        const matchedSaleItem = saleItems.find(si =>
          String(si.medicine_id) === String(billItem.medicine_id) &&
          String(si.batch_id) === String(billItem.batch_id)
        );

        const quantity = billItem.quantity_base_units || billItem.quantity || 0;
        const amount = billItem.amount || billItem.total_price || 0;

        let purchaseRate = 0;
        let purchaseAmount = 0;
        let grossProfit = 0;

        if (matchedSaleItem) {
          purchaseRate = matchedSaleItem.purchase_rate_per_base_unit || 0;
          purchaseAmount = matchedSaleItem.purchase_amount || (purchaseRate * quantity);
          grossProfit = matchedSaleItem.gross_profit || (amount - purchaseAmount);

          if (matchedSaleItem.purchase_amount) {
            purchaseAmount = matchedSaleItem.purchase_amount;
          }
          if (matchedSaleItem.gross_profit) {
            grossProfit = matchedSaleItem.gross_profit;
          }

          if (grossProfit === 0 && purchaseAmount > 0) {
            grossProfit = amount - purchaseAmount;
          }
        } else {
          purchaseRate = billItem.purchase_rate_per_base_unit || billItem.purchaseRatePerBaseUnit || 0;
          purchaseAmount = billItem.purchase_amount || billItem.purchaseAmount || (purchaseRate * quantity);
          grossProfit = amount - purchaseAmount;
        }

        if (!billItem.isReturned && billItem.item_type !== 'Medicine Return') {
          totalPurchaseCost += purchaseAmount > 0 ? purchaseAmount : 0;
          totalGrossProfit += grossProfit;
        }

        enrichedItems.push({
          ...billItem,
          purchase_rate_per_base_unit: purchaseRate,
          purchase_amount: purchaseAmount,
          gross_profit: grossProfit,
          isReturned: billItem.item_type === 'Medicine Return' || billItem.isReturned || false
        });
      }

      if (totalPurchaseCost === 0 && bill.sale_id.total_purchase_cost) {
        totalPurchaseCost = bill.sale_id.total_purchase_cost;
      }

      if (totalGrossProfit === 0 && bill.sale_id.gross_profit) {
        totalGrossProfit = bill.sale_id.gross_profit;
      }
    } else {
      for (const billItem of (bill.items || [])) {
        if (billItem.isReturned || billItem.item_type === 'Medicine Return') continue;

        const quantity = billItem.quantity_base_units || billItem.quantity || 0;
        const amount = billItem.amount || billItem.total_price || 0;
        const purchaseRate = billItem.purchase_rate_per_base_unit || billItem.purchaseRatePerBaseUnit || 0;
        const purchaseAmount = billItem.purchase_amount || billItem.purchaseAmount || (purchaseRate * quantity);
        const grossProfit = amount - purchaseAmount;

        totalPurchaseCost += purchaseAmount;
        totalGrossProfit += grossProfit;

        enrichedItems.push({
          ...billItem,
          purchase_rate_per_base_unit: purchaseRate,
          purchase_amount: purchaseAmount,
          gross_profit: grossProfit,
          isReturned: false
        });
      }
    }

    if (!totalGST && bill.items) {
      totalGST = bill.items.reduce((sum, item) => {
        if (item.isReturned || item.item_type === 'Medicine Return') return sum;
        return sum + (item.tax_amount || item.taxAmount || 0);
      }, 0);
    }

    const grossAmount = (bill.subtotal || 0) + (bill.discount_amount || bill.discount || 0);

    return {
      ...bill,
      bill_number: bill.sale_id?.sale_number || bill.sale_number || bill._id,
      invoice_number: bill.invoice_id?.invoice_number || bill.invoice_number,
      patient_name: bill.patient_id ? `${bill.patient_id.first_name || ''} ${bill.patient_id.last_name || ''}`.trim() : 'Walk-in',
      items_count: bill.items?.length || 0,
      ward_name: wardName,
      bed_number: bedNumber,
      ward_id: wardId,
      bed_id: bedId,
      admission_number: admissionNumber,
      purchase_cost: totalPurchaseCost,
      gross_profit: totalGrossProfit,
      profit_margin: totalPurchaseCost > 0 ? (totalGrossProfit / totalPurchaseCost * 100) : 0,
      gst_amount: totalGST,
      gross_amount: grossAmount,
      items: enrichedItems
    };
  });

  const billTotals = {
    totalAmount: enrichedBills.reduce((sum, b) => sum + (b.total_amount || 0), 0),
    totalPaid: enrichedBills.reduce((sum, b) => sum + (b.paid_amount || 0), 0),
    totalBalance: enrichedBills.reduce((sum, b) => sum + (b.balance_due || 0), 0),
    totalPurchaseCost: enrichedBills.reduce((sum, b) => sum + (b.purchase_cost || 0), 0),
    totalGrossProfit: enrichedBills.reduce((sum, b) => sum + (b.gross_profit || 0), 0),
    totalGST: enrichedBills.reduce((sum, b) => sum + (b.gst_amount || 0), 0),
    count: enrichedBills.length,
    paidCount: enrichedBills.filter(b => b.status === 'Paid').length,
    pendingCount: enrichedBills.filter(b => b.status === 'Pending' || b.status === 'Partially Paid').length
  };

  const totals = {
    IN_Cash: 0, OUT_Cash: 0,
    IN_UPI: 0, OUT_UPI: 0,
    IN_Card: 0, OUT_Card: 0,
    IN_Bank_Transfer: 0, OUT_Bank_Transfer: 0,
    NON_CASH_IPDAdvance: 0, NON_CASH_PharmacyAdvance: 0,
    discounts: 0, refunds: 0, returns_total: 0,
    netCash: 0, totalReceived: 0, totalRefunds: 0
  };

  enrichedEntries.forEach(entry => {
    const method = entry.paymentMethod || 'Unknown';
    const amount = Math.abs(entry.amount);

    if (entry.entryType === 'RETURN') {
      totals.returns_total += amount;
      totals.refunds += amount;
      if (method === 'IPDAdvance') {
        totals.NON_CASH_IPDAdvance += amount;
      } else if (method === 'PharmacyAdvance') {
        totals.NON_CASH_PharmacyAdvance += amount;
      } else {
        const outKey = `OUT_${method}`;
        if (totals.hasOwnProperty(outKey)) totals[outKey] += amount;
      }
    }
    else if (entry.entryType === 'ADVANCE_USED') {
      if (method === 'IPDAdvance') totals.NON_CASH_IPDAdvance += amount;
      else if (method === 'PharmacyAdvance') totals.NON_CASH_PharmacyAdvance += amount;
    }
    else if (entry.entryType === 'DISCOUNT') {
      totals.discounts += amount;
    }
    else if (entry.entryType === 'ADVANCE_RECEIVED') {
      const inKey = `IN_${method}`;
      if (totals.hasOwnProperty(inKey)) totals[inKey] += amount;
      totals.totalReceived += amount;
    }
    else {
      if (entry.direction === 'IN') {
        const inKey = `IN_${method}`;
        if (totals.hasOwnProperty(inKey)) totals[inKey] += amount;
        totals.totalReceived += amount;
      }
      else if (entry.direction === 'OUT') {
        const outKey = `OUT_${method}`;
        if (totals.hasOwnProperty(outKey)) totals[outKey] += amount;
        totals.totalRefunds += amount;
      }
    }
  });

  totals.netCash = (totals.IN_Cash || 0) - (totals.OUT_Cash || 0);
  totals.totalReceived = (totals.IN_Cash || 0) + (totals.IN_UPI || 0) + (totals.IN_Card || 0) + (totals.IN_Bank_Transfer || 0);
  totals.totalRefunds = (totals.OUT_Cash || 0) + (totals.OUT_UPI || 0) + (totals.OUT_Card || 0);

  const summary = {
    byPaymentMethod: {
      Cash: { received: totals.IN_Cash || 0, refunded: totals.OUT_Cash || 0, net: (totals.IN_Cash || 0) - (totals.OUT_Cash || 0) },
      UPI: { received: totals.IN_UPI || 0, refunded: totals.OUT_UPI || 0, net: (totals.IN_UPI || 0) - (totals.OUT_UPI || 0) },
      Card: { received: totals.IN_Card || 0, refunded: totals.OUT_Card || 0, net: (totals.IN_Card || 0) - (totals.OUT_Card || 0) },
      BankTransfer: { received: totals.IN_Bank_Transfer || 0, refunded: totals.OUT_Bank_Transfer || 0, net: (totals.IN_Bank_Transfer || 0) - (totals.OUT_Bank_Transfer || 0) }
    },
    advanceUtilization: { IPDAdvance: totals.NON_CASH_IPDAdvance || 0, PharmacyAdvance: totals.NON_CASH_PharmacyAdvance || 0 },
    discounts: totals.discounts || 0,
    returns: totals.returns_total || 0,
    totalReceived: totals.totalReceived,
    totalRefunds: totals.totalRefunds,
    netCash: totals.netCash,
    totalPurchaseCost: billTotals.totalPurchaseCost,
    totalGrossProfit: billTotals.totalGrossProfit,
    totalGST: billTotals.totalGST
  };

  const summaryAgg = await PharmacyLedgerEntry.aggregate([
    { $match: match },
    { $group: { _id: { paymentMethod: '$paymentMethod', direction: '$direction', entryType: '$entryType' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { '_id.paymentMethod': 1 } }
  ]);

  const legacyTotals = summaryAgg.reduce((acc, row) => {
    const key = `${row._id.direction}_${row._id.paymentMethod}`;
    acc[key] = normalizeMoney((acc[key] || 0) + row.amount);
    if (row._id.entryType === 'DISCOUNT') acc.discounts = normalizeMoney((acc.discounts || 0) + row.amount);
    if (row._id.entryType === 'REFUND') acc.refunds = normalizeMoney((acc.refunds || 0) + row.amount);
    return acc;
  }, {});

  res.json({
    success: true,
    range: { start, end },
    totals: legacyTotals,
    calculatedTotals: totals,
    summary: summary,
    entries: enrichedEntries,
    bills: enrichedBills,
    billTotals: billTotals
  });
});

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

    const deferredPayments = await Sale.find({
      admission_id: admission._id,
      payment_deferred: true,
      status: 'Pending'
    });

    const totalDeferredAmount = deferredPayments.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);

    const recentSales = await Sale.find({
      admission_id: admission._id,
      payment_deferred: { $ne: true }
    }).sort({ sale_date: -1 }).limit(5);

    const totalSalesAmount = recentSales.reduce((sum, sale) => sum + sale.total_amount, 0);

    return {
      ...admission.toObject(),
      pharmacyAdvance,
      sharedIpdAdvance,
      totalDeferredAmount,
      deferredCount: deferredPayments.length,
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

exports.getPatientPharmacyLedger = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const { admissionId, startDate, endDate, limit = 50 } = req.query;

  const patient = await Patient.findById(patientId).select('first_name last_name patientId phone uhid');
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

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

  const saleFilter = { patient_id: patient._id };
  if (admissionId) {
    saleFilter.admission_id = admissionId;
  }
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
    .limit(Number(limit))
    .lean();

  const advanceFilters = { patientId: patient._id };
  if (admissionId) {
    advanceFilters.admissionId = admissionId;
  }
  if (startDate && endDate) {
    advanceFilters.createdAt = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }

  const advanceLedgers = await PatientAdvanceLedger.find(advanceFilters)
    .sort({ createdAt: -1 })
    .limit(Number(limit));

  const pharmacyLedgerQuery = { patientId: patient._id };
  if (admissionId) {
    pharmacyLedgerQuery.admissionId = admissionId;
  }
  if (startDate && endDate) {
    pharmacyLedgerQuery.entryDate = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }

  const pharmacyLedgers = await PharmacyLedgerEntry.find(pharmacyLedgerQuery)
    .populate({
      path: 'saleId',
      select: 'sale_number invoice_number'
    })
    .populate({
      path: 'invoiceId',
      select: 'invoice_number'
    })
    .populate({
      path: 'returnId',
      select: 'returnNumber'
    })
    .sort({ entryDate: -1 })
    .limit(Number(limit))
    .lean();

  let totals = {
    totalIN: 0,
    totalOUT: 0,
    totalReturns: 0,
    totalDiscounts: 0,
    totalAdvanceUsed: 0,
    netBalance: 0
  };

  const enrichedPharmacyLedgers = pharmacyLedgers.map(entry => {
    const referenceNumber = entry.saleId?.sale_number ||
      entry.saleId?.invoice_number ||
      entry.invoiceId?.invoice_number ||
      entry.returnId?.returnNumber || null;

    const amount = Math.abs(entry.amount);
    if (entry.entryType === 'RETURN') {
      totals.totalReturns += amount;
    } else if (entry.entryType === 'DISCOUNT') {
      totals.totalDiscounts += amount;
    } else if (entry.entryType === 'ADVANCE_USED') {
      totals.totalAdvanceUsed += amount;
    } else if (entry.direction === 'IN') {
      totals.totalIN += amount;
    } else if (entry.direction === 'OUT') {
      totals.totalOUT += amount;
    }

    return {
      ...entry,
      saleNumber: entry.saleId?.sale_number || null,
      invoiceNumber: entry.invoiceId?.invoice_number || null,
      returnNumber: entry.returnId?.returnNumber || null,
      referenceNumber: referenceNumber
    };
  });

  totals.netBalance = totals.totalIN - totals.totalOUT;

  const returnsFilter = { patientId: patient._id };
  if (admissionId) {
    returnsFilter.admissionId = admissionId;
  }
  const returns = await PharmacyReturn.find(returnsFilter)
    .sort({ createdAt: -1 })
    .limit(Number(limit));

  const saleIds = sales.filter(s => s._id).map(s => s._id);
  const billsQuery = {
    $or: [
      { patient_id: patient._id, is_pharmacy_bill: true },
      { sale_id: { $in: saleIds } }
    ]
  };
  if (admissionId) {
    billsQuery.admission_id = admissionId;
  }
  if (startDate && endDate) {
    billsQuery.generated_at = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }

  const bills = await Bill.find(billsQuery)
    .populate('patient_id', 'first_name last_name patientId')
    .populate('sale_id', 'sale_number invoice_number')
    .populate('invoice_id', 'invoice_number')
    .sort({ generated_at: -1 })
    .limit(Number(limit))
    .lean();

  const enrichedBills = bills.map(bill => ({
    ...bill,
    sale_number: bill.sale_id?.sale_number || bill.sale_number,
    invoice_number: bill.invoice_id?.invoice_number || bill.invoice_number,
    bill_number: bill.sale_id?.sale_number || bill.sale_number || bill._id
  }));

  const currentBalances = {
    sharedIpdAdvance: 0,
    pharmacyAdvance: 0,
    totalSpent: 0,
    pendingBills: 0,
    totalDeferred: 0
  };

  const targetAdmissions = admissions.length > 0 ? admissions : [];

  for (const admission of targetAdmissions) {
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

  const allSales = await Sale.find({
    patient_id: patient._id,
    ...(admissionId && { admission_id: admissionId })
  });
  currentBalances.totalSpent = allSales.reduce((sum, sale) => sum + sale.total_amount, 0);

  const deferredSales = allSales.filter(sale => sale.payment_deferred === true);
  currentBalances.totalDeferred = deferredSales.reduce((sum, sale) => sum + sale.balance_due, 0);

  const pendingSales = await Sale.find({
    patient_id: patient._id,
    balance_due: { $gt: 0 },
    payment_deferred: { $ne: true },
    ...(admissionId && { admission_id: admissionId })
  });
  currentBalances.pendingBills = pendingSales.reduce((sum, sale) => sum + sale.balance_due, 0);

  const pendingBillsAmount = enrichedBills
    .filter(b => b.status !== 'Paid' && b.status !== 'Cancelled')
    .reduce((sum, b) => sum + (b.balance_due || (b.total_amount - b.paid_amount)), 0);

  if (pendingBillsAmount > currentBalances.pendingBills) {
    currentBalances.pendingBills = pendingBillsAmount;
  }

  res.json({
    success: true,
    patient: {
      _id: patient._id,
      first_name: patient.first_name,
      last_name: patient.last_name,
      patientId: patient.patientId,
      uhid: patient.uhid,
      phone: patient.phone,
      full_name: `${patient.first_name} ${patient.last_name || ''}`.trim()
    },
    admissions: targetAdmissions,
    transactions: {
      sales,
      deferredSales,
      advanceLedgers,
      pharmacyLedgers: enrichedPharmacyLedgers,
      returns,
      bills: enrichedBills
    },
    totals,
    balances: currentBalances,
    summary: {
      totalSales: allSales.length,
      totalDeferred: deferredSales.length,
      totalReturns: returns.length,
      totalBills: enrichedBills.length,
      lastTransaction: sales[0]?.sale_date || null,
      totalAmount: totals.totalIN,
      totalRefunds: totals.totalOUT + totals.totalReturns,
      netBalance: totals.netBalance
    }
  });
});

exports.refundPharmacyAdvance = asyncHandler(async (req, res) => {
  const hospitalId = getHospitalId(req, req.body.hospitalId);

  const admissionId = objectIdOrUndefined(
    req.params.admissionId ||
    req.body.admissionId ||
    req.body.admission_id
  );

  const patientId = objectIdOrUndefined(
    req.body.patientId ||
    req.body.patient_id
  );

  const pharmacyId =
    objectIdOrUndefined(req.body.pharmacyId || req.body.pharmacy_id) ||
    await getDefaultPharmacyId();

  const amount = normalizeMoney(req.body.amount);
  const refundMethod = req.body.refundMethod || req.body.paymentMethod || req.body.payment_method || 'Cash';
  const referenceNumber =
    req.body.reference ||
    req.body.referenceNumber ||
    req.body.reference_number ||
    `PH-ADV-REF-${Date.now()}`;

  const notes = req.body.notes || 'Final pharmacy clearance advance refund';

  const createdByRaw = getCreatedBy(req);
  const collectedByName = req.body.refunded_by || req.body.collected_by || req.body.collectedBy || 'Pharmacy Staff';

  let createdBy = null;
  if (createdByRaw && mongoose.Types.ObjectId.isValid(createdByRaw)) {
    createdBy = createdByRaw;
  } else {
    try {
      const User = require('../models/User');
      let user = null;

      if (collectedByName.includes('@')) {
        user = await User.findOne({ email: collectedByName });
      } else {
        const nameParts = collectedByName.split(' ');
        if (nameParts.length >= 2) {
          user = await User.findOne({
            first_name: nameParts[0],
            last_name: nameParts.slice(1).join(' ')
          });
        } else {
          user = await User.findOne({
            $or: [
              { username: collectedByName },
              { first_name: collectedByName }
            ]
          });
        }
      }

      if (user) {
        createdBy = user._id;
      }
    } catch (userErr) {
      console.log('Could not find user by name/email, using system as fallback');
    }
  }

  if (!createdBy) {
    createdBy = req.user?._id || req.user?.id || null;
  }

  const createdByName = collectedByName || req.user?.name || 'Pharmacy Staff';

  if (!admissionId) {
    return res.status(400).json({
      success: false,
      error: 'admissionId is required'
    });
  }

  if (!patientId) {
    return res.status(400).json({
      success: false,
      error: 'patientId is required'
    });
  }

  if (!pharmacyId) {
    return res.status(400).json({
      success: false,
      error: 'Active pharmacy not found'
    });
  }

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Refund amount must be greater than zero'
    });
  }

  const currentPharmacyAdvance = await getAdvanceBalance({
    admissionId,
    patientId,
    walletType: 'PHARMACY_IPD'
  });

  if (currentPharmacyAdvance <= 0) {
    return res.status(400).json({
      success: false,
      error: 'No pharmacy advance balance available for refund'
    });
  }

  if (amount > currentPharmacyAdvance + 0.01) {
    return res.status(400).json({
      success: false,
      error: `Refund amount cannot exceed available pharmacy advance balance. Available ${currentPharmacyAdvance}, requested ${amount}`
    });
  }

  const summary = await getPatientPharmacySummary({
    patientId,
    admissionId
  });

  if (Number(summary.outstanding || 0) > 0) {
    return res.status(400).json({
      success: false,
      error: `Cannot refund pharmacy advance while pharmacy outstanding exists. Outstanding amount: ${summary.outstanding}`
    });
  }

  const advanceLedger = await createAdvanceLedgerEntry({
    hospitalId,
    patientId,
    admissionId,
    walletType: 'PHARMACY_IPD',
    transactionType: 'PHARMACY_ADVANCE_REFUND',
    direction: 'DEBIT',
    amount,
    paymentMethod: refundMethod,
    referenceNumber,
    sourceModule: 'Pharmacy',
    sourceId: admissionId,
    notes,
    createdBy: createdBy || 'System'
  });

  const pharmacyLedger = await PharmacyLedgerEntry.create({
    hospitalId,
    pharmacyId,
    entryType: 'REFUND',
    direction: 'OUT',
    amount: normalizeMoney(amount),
    paymentMethod: refundMethod,
    patientId,
    admissionId,
    notes: `${notes}. Reference: ${referenceNumber}. Refunded by: ${createdByName}`,
    createdBy: createdBy || 'System'
  });

  await Patient.findByIdAndUpdate(patientId, {
    $set: {
      pharmacy_advance_balance: Math.max(0, normalizeMoney(advanceLedger.balanceAfter || 0)),
      last_pharmacy_transaction: new Date()
    }
  });

  const balances = await getPatientPharmacySummary({
    patientId,
    admissionId
  });

  res.status(201).json({
    success: true,
    message: 'Pharmacy advance refunded successfully',
    refundedAmount: amount,
    refundMethod,
    referenceNumber,
    refundedBy: createdByName,
    balanceBefore: normalizeMoney(currentPharmacyAdvance),
    balanceAfter: normalizeMoney(advanceLedger.balanceAfter || 0),
    advanceLedger,
    pharmacyLedger,
    balances
  });
});

exports.getDashboard = asyncHandler(async (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const [salesAgg, ledgerAgg, pendingIpd, lowStockCount, nearExpiryCount, pendingPO, recentSales, recentReturns, recentBills, invoiceStats, deferredCount] = await Promise.all([
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
    PharmacyReturn.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    Bill.find({ is_pharmacy_bill: true }).sort({ generated_at: -1 }).limit(10).populate('patient_id', 'first_name last_name patientId').lean(),
    Invoice.aggregate([
      { $match: { is_pharmacy_sale: true, issue_date: { $gte: start, $lte: end } } },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } }
    ]),
    Sale.countDocuments({ payment_deferred: true, status: 'Pending' })
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
      pendingPurchaseOrders: pendingPO,
      deferredPaymentsCount: deferredCount
    },
    recentSales,
    recentReturns,
    recentBills,
    invoiceStats
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
  const { q = '', limit = 20, patientId } = req.query;
  const text = String(q).trim();

  const admissionQuery = { status: { $ne: 'Discharged' } };

  if (patientId) {
    admissionQuery.patientId = patientId;
  }

  if (text && !patientId) {
    const matchingPatients = await Patient.find({
      $or: [
        { patientId: { $regex: text, $options: 'i' } },
        { uhid: { $regex: text, $options: 'i' } },
        { phone: { $regex: text, $options: 'i' } },
        { first_name: { $regex: text, $options: 'i' } }
      ]
    }).select('_id').lean();

    const patientIds = matchingPatients.map(p => p._id);

    admissionQuery.$or = [
      { admissionNumber: { $regex: text, $options: 'i' } },
      { shipNumber: { $regex: text, $options: 'i' } },
      { patientId: { $in: patientIds } }
    ];
  }

  const admissions = await IPDAdmission.find(admissionQuery)
    .populate('patientId', 'first_name last_name patientId uhid phone sponsor_type sponsor_name')
    .populate('primaryDoctorId', 'firstName lastName')
    .populate('wardId', 'name')
    .populate('bedId', 'bedNumber bedType')
    .populate('roomId', 'room_number type name')
    .sort({ admissionDate: -1 })
    .limit(Number(limit))
    .lean();

  res.json({ success: true, admissions });
});

exports.getDoseCalculation = asyncHandler(async (req, res) => {
  const requiredQtyBaseUnits = calculateRequiredBaseUnits(req.query);
  res.json({ success: true, requiredQtyBaseUnits });
});

// ========== NEW: Bulk Settle Deferred Payments ==========
exports.bulkSettleDeferredPayments = asyncHandler(async (req, res) => {
  const { postLedgerSettlement } = require('../services/pharmacyLedgerSettlement.service');
  const hospitalId = getHospitalId(req, req.body.hospitalId);
  const pharmacyId = objectIdOrUndefined(req.body.pharmacyId) || await getDefaultPharmacyId();
  const createdBy = getCreatedBy(req);

  const result = await postLedgerSettlement({
    patientId: req.body.patientId,
    admissionId: req.body.admissionId,
    saleIds: req.body.saleIds,
    settlementType: 'FINAL_CONCESSION',
    discountScope: req.body.discountBase === 'total' ? 'FULL_LEDGER_GROSS' : 'UNPAID_DUE',
    discountType: String(req.body.discountType || 'percentage').toUpperCase(),
    discountValue: req.body.discount || 0,
    percentageTreatment: 'ADDITIONAL',
    allocationPolicy: req.body.allocationPolicy || 'PROPORTIONAL',
    allocations: req.body.allocations,
    payments: req.body.payments || [],
    reason: req.body.reason || 'Legacy bulk deferred-payment settlement',
    notes: req.body.notes || '',
    idempotencyKey: req.body.idempotencyKey,
  }, { hospitalId, pharmacyId, createdBy: createdBy || req.body.createdBy });

  const settlement = result.settlement;
  res.status(result.replayed ? 200 : 201).json({
    success: true,
    replayed: result.replayed,
    message: result.replayed ? 'Existing settlement returned.' : 'Deferred payments settled through final ledger settlement.',
    settlement,
    summary: {
      totalDue: settlement.opening_outstanding_total,
      discountAmount: settlement.discount_applied,
      amountAfterDiscount: settlement.payment_received,
      totalPaid: settlement.payment_received,
      discountType: settlement.discount_type,
    },
    settlements: settlement.allocations.map((allocation) => ({
      saleId: allocation.sale_id,
      saleNumber: allocation.sale_number,
      paid: allocation.payment_allocated,
      discount: allocation.settlement_discount_allocated,
      creditNote: allocation.credit_note_allocated,
      balance_due: allocation.closing_due,
    })),
    paymentBreakdown: settlement.payment_breakdown,
  });
});

// ========== NEW: Get Deferred Settlement Summary ==========
exports.getDeferredSettlementSummary = asyncHandler(async (req, res) => {
  const { admissionId } = req.params;

  if (!admissionId) {
    return res.status(400).json({ success: false, error: 'admissionId is required' });
  }

  const deferredSales = await Sale.find({
    admission_id: admissionId,
    payment_deferred: true,
    status: { $in: ['Pending', 'Partially Paid'] }
  }).select('sale_number total_amount amount_paid balance_due sale_date items medicine_name');

  const totalDue = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
  const pharmacyAdvance = await getAdvanceBalance({ admissionId, walletType: 'PHARMACY_IPD' });
  const sharedIpdAdvance = await getAdvanceBalance({ admissionId, walletType: 'IPD_SHARED' });

  let patientId = null;
  let patientName = null;
  if (deferredSales.length > 0) {
    patientId = deferredSales[0].patient_id;
    const patient = await Patient.findById(patientId).select('first_name last_name patientId');
    if (patient) {
      patientName = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();
    }
  }

  res.json({
    success: true,
    deferredPayments: deferredSales.map(sale => ({
      _id: sale._id,
      sale_number: sale.sale_number,
      total_amount: sale.total_amount,
      amount_paid: sale.amount_paid,
      balance_due: sale.balance_due,
      sale_date: sale.sale_date,
      items_count: sale.items?.length || 0
    })),
    totalDue,
    pharmacyAdvance,
    sharedIpdAdvance,
    count: deferredSales.length,
    patientId,
    patientName
  });
});

// ========== NEW: Get Inventory Batches for POS ==========
exports.getInventoryBatches = asyncHandler(async (req, res) => {
  const { medicineId, status = 'active', limit = 100 } = req.query;

  const query = {};
  if (medicineId) query.medicine_id = medicineId;
  if (status === 'active') query.is_active = true;
  if (status === 'inactive') query.is_active = false;

  // Only show batches with stock
  query.quantity_base_units = { $gt: 0 };

  const batches = await MedicineBatch.find(query)
    .populate('medicine_id', 'name base_unit pack_unit units_per_pack gst_rate hsn_code allow_loose_sale')
    .sort({ expiry_date: 1 })
    .limit(Number(limit))
    .lean();

  // Add computed fields for frontend
  const enrichedBatches = batches.map(batch => {
    const medicine = batch.medicine_id || {};
    return {
      ...batch,
      sellingPricePerBaseUnit: batch.selling_price_per_base_unit,
      selling_price_per_base_unit: batch.selling_price_per_base_unit,
      sellingPricePerPack: batch.selling_price_per_pack,
      selling_price_per_pack: batch.selling_price_per_pack,
      purchasePricePerBaseUnit: batch.purchase_price_per_base_unit,
      purchase_price_per_base_unit: batch.purchase_price_per_base_unit,
      purchasePricePerPack: batch.purchase_price_per_pack,
      purchase_price_per_pack: batch.purchase_price_per_pack,
      mrpPerPack: batch.mrp_per_pack,
      mrp_per_pack: batch.mrp_per_pack,
      batchNumber: batch.batch_number,
      batch_number: batch.batch_number,
      expiryDate: batch.expiry_date,
      expiry_date: batch.expiry_date,
      quantityBaseUnits: batch.quantity_base_units,
      quantity_base_units: batch.quantity_base_units,
      unitsPerPack: batch.units_per_pack,
      units_per_pack: batch.units_per_pack,
      tax_snapshot: batch.tax_snapshot,
      // Medicine fields for frontend
      medicine_name: medicine.name,
      base_unit: medicine.base_unit,
      pack_unit: medicine.pack_unit,
      allow_loose_sale: medicine.allow_loose_sale,
      gst_rate: batch.tax_snapshot?.gst_rate || medicine.gst_rate,
      hsn_code: batch.tax_snapshot?.hsn_code || medicine.hsn_code,
    };
  });

  res.json({ success: true, batches: enrichedBatches });
});

// ========== NEW: Get Hospital Details ==========
exports.getHospitalDetails = asyncHandler(async (req, res) => {
  const hospitalId = req.user?.hospital_id || req.user?.hospitalId;

  if (!hospitalId) {
    // Return default if no hospital ID found
    return res.json({
      success: true,
      data: {
        name: 'CITY HOSPITAL',
        hospitalName: 'CITY HOSPITAL',
        address: '123 Healthcare Avenue, Medical District',
        contact: '+91 12345 67890',
        email: 'info@cityhospital.com',
        logo: null,
        gst: '27AAAAA1234A1Z',
        gst_number: '27AAAAA1234A1Z'
      }
    });
  }

  const hospital = await Hospital.findById(hospitalId)
    .select('hospitalName name address contact email logo gst gst_number vitalsEnabled vitalsController')
    .lean();

  if (!hospital) {
    return res.json({
      success: true,
      data: {
        name: 'CITY HOSPITAL',
        hospitalName: 'CITY HOSPITAL',
        address: '123 Healthcare Avenue, Medical District',
        contact: '+91 12345 67890',
        email: 'info@cityhospital.com',
        logo: null,
        gst: '27AAAAA1234A1Z',
        gst_number: '27AAAAA1234A1Z'
      }
    });
  }

  res.json({
    success: true,
    data: {
      name: hospital.hospitalName || hospital.name,
      hospitalName: hospital.hospitalName || hospital.name,
      address: hospital.address,
      contact: hospital.contact,
      email: hospital.email,
      logo: hospital.logo,
      gst: hospital.gst || hospital.gst_number,
      gst_number: hospital.gst || hospital.gst_number,
      vitalsEnabled: hospital.vitalsEnabled,
      vitalsController: hospital.vitalsController
    }
  });
});

// ========== NEW: Enhanced Medicine Search ==========
exports.searchMedicines = asyncHandler(async (req, res) => {
  const { query = '', limit = 30, searchBy = 'name' } = req.query;

  if (!query || query.length < 2) {
    return res.json({ success: true, data: [] });
  }

  const searchRegex = new RegExp(query, 'i');
  const searchConditions = [];

  // Search by name
  if (searchBy === 'name' || searchBy === 'all') {
    searchConditions.push({ name: searchRegex });
  }

  // Search by generic name
  if (searchBy === 'generic' || searchBy === 'all') {
    searchConditions.push({ generic_name: searchRegex });
  }

  // Search by composition
  if (searchBy === 'composition' || searchBy === 'all') {
    searchConditions.push({ composition: searchRegex });
    searchConditions.push({ composition_keywords: { $in: [query.toLowerCase()] } });
  }

  // Search by brand
  if (searchBy === 'brand' || searchBy === 'all') {
    searchConditions.push({ brand: searchRegex });
  }

  // Search by category
  if (searchBy === 'category' || searchBy === 'all') {
    searchConditions.push({ category: searchRegex });
  }

  const medicines = await Medicine.find({
    is_active: true,
    $or: searchConditions.length > 0 ? searchConditions : [{ name: searchRegex }]
  })
    .select('name generic_name composition brand category strength hsn_code gst_rate base_unit pack_unit units_per_pack allow_loose_sale min_stock_level is_own_brand')
    .limit(Number(limit))
    .lean();

  // Enrich with batch stock information
  const medicineIds = medicines.map(m => m._id);
  const batches = await MedicineBatch.find({
    medicine_id: { $in: medicineIds },
    is_active: true,
    quantity_base_units: { $gt: 0 }
  })
    .sort({ expiry_date: 1 })
    .select('medicine_id batch_number expiry_date quantity_base_units units_per_pack selling_price_per_base_unit selling_price_per_pack mrp_per_pack purchase_price_per_base_unit tax_snapshot')
    .lean();

  const batchesByMedicine = batches.reduce((acc, batch) => {
    const key = String(batch.medicine_id);
    if (!acc[key]) acc[key] = [];
    acc[key].push(batch);
    return acc;
  }, {});

  const enrichedMedicines = medicines.map(medicine => {
    const medicineBatches = batchesByMedicine[String(medicine._id)] || [];
    const totalStock = medicineBatches.reduce((sum, b) => sum + Number(b.quantity_base_units || 0), 0);

    return {
      ...medicine,
      stock_quantity: totalStock,
      batches: medicineBatches,
      batch_count: medicineBatches.length,
      earliest_expiry: medicineBatches[0]?.expiry_date || null,
      sellingPricePerBaseUnit: medicineBatches[0]?.selling_price_per_base_unit || 0,
      mrp: medicineBatches[0]?.mrp_per_pack || 0,
      taxRate: medicineBatches[0]?.tax_snapshot?.gst_rate || medicine.gst_rate || 0
    };
  });

  // Sort by stock availability (in stock first, then by name)
  enrichedMedicines.sort((a, b) => {
    if (a.stock_quantity > 0 && b.stock_quantity <= 0) return -1;
    if (a.stock_quantity <= 0 && b.stock_quantity > 0) return 1;
    return a.name.localeCompare(b.name);
  });

  res.json({
    success: true,
    data: enrichedMedicines.slice(0, Number(limit))
  });
});