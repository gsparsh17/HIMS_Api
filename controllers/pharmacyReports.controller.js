const ExcelJS = require('exceljs');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const InventoryLedger = require('../models/InventoryLedger');
const Sale = require('../models/Sale');
const PharmacyReturn = require('../models/PharmacyReturn');
const Doctor = require('../models/Doctor');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const { operationNow, operationDateKey } = require('../utils/operationTimeContext');
const { getHospitalId, objectIdOrUndefined, normalizeMoney } = require('../services/pharmacyTransaction.service');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireHospital(req) {
  const hospitalId = getHospitalId(req);
  if (!hospitalId) {
    const error = new Error('Hospital context is required');
    error.statusCode = 403;
    error.code = 'HOSPITAL_CONTEXT_REQUIRED';
    throw error;
  }
  return hospitalId;
}

function signedQuantity(entry) {
  const qty = Number(entry.quantityBaseUnits || 0);
  return entry.direction === 'IN' ? qty : -qty;
}

function movementDate(entry) {
  return new Date(entry.movementAt || entry.createdAt || 0);
}

function movementCode(entry) {
  if (entry.movementType === 'PURCHASE_IN') return 'MRN';
  if (entry.movementType === 'SALE_OUT') return 'SB';
  if (entry.movementType === 'RETURN_IN') return 'SBR';
  if (entry.movementType === 'OPENING') return 'ADD';
  if (entry.movementType === 'WASTE_OUT') return 'EXP';
  if (entry.movementType === 'ADJUSTMENT_IN') return 'ADD';
  if (entry.movementType === 'ADJUSTMENT_OUT') return 'ROT';
  return entry.movementType || 'ADJ';
}

async function hospitalMedicines(hospitalId, extra = {}) {
  return Medicine.find({ hospitalId, ...extra })
    .select('_id name generic_name brand category composition hsn_code gst_rate base_unit pack_unit units_per_pack')
    .lean();
}

async function hospitalBatches(hospitalId, extra = {}) {
  const medicines = await hospitalMedicines(hospitalId);
  const medicineIds = medicines.map((m) => m._id);
  if (!medicineIds.length) return { medicines, batches: [] };
  const batches = await MedicineBatch.find({ medicine_id: { $in: medicineIds }, ...extra })
    .populate('supplier_id', 'name supplier_name company_name')
    .lean();
  return { medicines, batches };
}

async function loadLedgerForBatches(hospitalId, batchIds, extra = {}) {
  if (!batchIds.length) return [];
  return InventoryLedger.find({
    batchId: { $in: batchIds },
    $or: [{ hospitalId }, { hospitalId: { $exists: false } }, { hospitalId: null }],
    ...extra,
  }).sort({ movementAt: 1, createdAt: 1, _id: 1 }).lean();
}

function openingFallback(batch, entries, cutoff) {
  const hasOpening = entries.some((entry) => entry.movementType === 'OPENING' || entry.movementType === 'PURCHASE_IN');
  if (hasOpening) return 0;
  const createdAt = new Date(batch.createdAt || batch.received_date || batch.purchase_date || 0);
  return createdAt <= cutoff ? Number(batch.opening_quantity_base_units ?? 0) : 0;
}


exports.getDoctorOptions = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const filter = { hospitalId, is_active: { $ne: false } };
  if (req.query.q) {
    const q = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q) {
      filter.$or = [
        { firstName: { $regex: q, $options: 'i' } },
        { lastName: { $regex: q, $options: 'i' } },
        { specialization: { $regex: q, $options: 'i' } }
      ];
    }
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 250)));
  const doctors = await Doctor.find(filter)
    .select('_id doctorId firstName lastName specialization department')
    .populate('department', '_id name code')
    .sort({ firstName: 1, lastName: 1 })
    .limit(limit)
    .lean();
  res.json(doctors);
});

exports.getStockItemWise = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const medicineId = objectIdOrUndefined(req.query.medicineId);
  if (!medicineId) return res.status(400).json({ success: false, error: 'medicineId is required' });

  const medicine = await Medicine.findOne({ _id: medicineId, hospitalId }).lean();
  if (!medicine) return res.status(404).json({ success: false, error: 'Medicine not found' });

  const selectedDay = operationDateKey();
  const startDate = req.query.startDate || selectedDay;
  const endDate = req.query.endDate || selectedDay;
  const range = semanticDateRange(startDate, endDate);
  const start = range.$gte;
  const endExclusive = range.$lt || new Date(range.$lte.getTime() + 1);

  const batchQuery = { medicine_id: medicineId };
  if (req.query.batchId) batchQuery._id = objectIdOrUndefined(req.query.batchId);
  const batches = await MedicineBatch.find(batchQuery).sort({ createdAt: 1 }).lean();
  const batchIds = batches.map((b) => b._id);
  const entries = await loadLedgerForBatches(hospitalId, batchIds);
  const grouped = new Map();
  for (const entry of entries) {
    const key = String(entry.batchId || '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const batchRows = batches.map((batch) => {
    const batchEntries = grouped.get(String(batch._id)) || [];
    let opening = openingFallback(batch, batchEntries, start);
    for (const entry of batchEntries) {
      if (movementDate(entry) < start) opening += signedQuantity(entry);
    }

    let running = opening;
    const movements = batchEntries
      .filter((entry) => {
        const at = movementDate(entry);
        return at >= start && at < endExclusive;
      })
      .map((entry) => {
        const signed = signedQuantity(entry);
        const before = running;
        running += signed;
        return {
          _id: entry._id,
          date: movementDate(entry),
          particular: movementCode(entry),
          reference: entry.notes || String(entry.sourceId || ''),
          movementType: entry.movementType,
          receivedQty: signed > 0 ? signed : 0,
          issuedQty: entry.movementType === 'SALE_OUT' ? Math.abs(signed) : 0,
          returnedQty: entry.movementType === 'RETURN_IN' ? Math.abs(signed) : 0,
          adjustedOutQty: signed < 0 && entry.movementType !== 'SALE_OUT' ? Math.abs(signed) : 0,
          stockBefore: normalizeMoney(before),
          qtyBalance: normalizeMoney(running),
          quantity: Math.abs(Number(entry.quantityBaseUnits || 0)),
        };
      });

    const purchaseRate = Number(batch.purchase_price_per_base_unit ?? ((batch.purchase_price_per_pack || batch.purchase_price || 0) / (batch.units_per_pack || 1)) ?? 0);
    return {
      batchId: batch._id,
      batchNumber: batch.batch_number,
      openingStock: normalizeMoney(opening),
      closingStock: normalizeMoney(running),
      purchaseRate: normalizeMoney(purchaseRate),
      stockValue: normalizeMoney(running * purchaseRate),
      movements,
    };
  });

  res.json({
    success: true,
    range: { start, end: endExclusive },
    medicine,
    totals: {
      openingStock: normalizeMoney(batchRows.reduce((sum, row) => sum + row.openingStock, 0)),
      closingStock: normalizeMoney(batchRows.reduce((sum, row) => sum + row.closingStock, 0)),
      stockValue: normalizeMoney(batchRows.reduce((sum, row) => sum + row.stockValue, 0)),
    },
    batches: batchRows,
  });
});

exports.getBackDateStock = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const asOn = req.query.date || operationDateKey();
  const day = semanticDateRange(asOn, asOn);
  const cutoff = day.$lt || new Date(day.$lte.getTime() + 1);
  const { medicines, batches } = await hospitalBatches(hospitalId);
  const medicineMap = new Map(medicines.map((m) => [String(m._id), m]));
  const entries = await loadLedgerForBatches(hospitalId, batches.map((b) => b._id));
  const grouped = new Map();
  for (const entry of entries) {
    const key = String(entry.batchId || '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }

  const rows = [];
  let incompleteHistoryBatches = 0;
  for (const batch of batches) {
    const medicine = medicineMap.get(String(batch.medicine_id));
    if (!medicine) continue;
    const batchEntries = grouped.get(String(batch._id)) || [];
    const hasOpening = batchEntries.some((entry) => ['OPENING', 'PURCHASE_IN'].includes(entry.movementType));
    if (!hasOpening) incompleteHistoryBatches += 1;
    let stock = openingFallback(batch, batchEntries, cutoff);
    for (const entry of batchEntries) {
      if (movementDate(entry) < cutoff) stock += signedQuantity(entry);
    }
    stock = Math.max(0, normalizeMoney(stock));
    if (stock <= 0 && req.query.includeZero !== 'true') continue;

    const unitsPerPack = Number(batch.units_per_pack || medicine.units_per_pack || 1);
    const purchaseRate = Number(batch.purchase_price_per_base_unit ?? ((batch.purchase_price_per_pack || batch.purchase_price || 0) / unitsPerPack) ?? 0);
    const mrpRate = Number((batch.mrp_per_pack || batch.selling_price_per_pack || batch.selling_price || 0) / unitsPerPack);
    rows.push({
      categoryName: medicine.category || 'Uncategorised',
      itemName: medicine.name,
      medicineId: medicine._id,
      batchId: batch._id,
      batchNumber: batch.batch_number,
      mrnNo: '',
      stock,
      purchaseRate: normalizeMoney(purchaseRate),
      mrpRate: normalizeMoney(mrpRate),
      purchaseValue: normalizeMoney(stock * purchaseRate),
      mrpValue: normalizeMoney(stock * mrpRate),
      expiryDate: batch.expiry_date,
      supplierName: batch.supplier_id?.name || batch.supplier_id?.supplier_name || batch.supplier_id?.company_name || '',
    });
  }

  rows.sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.itemName.localeCompare(b.itemName) || a.batchNumber.localeCompare(b.batchNumber));
  res.json({
    success: true,
    asOn,
    rows,
    totals: {
      stock: normalizeMoney(rows.reduce((sum, row) => sum + row.stock, 0)),
      purchaseValue: normalizeMoney(rows.reduce((sum, row) => sum + row.purchaseValue, 0)),
      mrpValue: normalizeMoney(rows.reduce((sum, row) => sum + row.mrpValue, 0)),
    },
    integrity: {
      incompleteHistoryBatches,
      warning: incompleteHistoryBatches
        ? 'Some legacy batches have no opening/purchase ledger entry. Run the pharmacy inventory-ledger backfill before relying on historical dates.'
        : null,
    },
  });
});

exports.getExpiryReport = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const { medicines, batches } = await hospitalBatches(hospitalId);
  const medicineMap = new Map(medicines.map((m) => [String(m._id), m]));
  const asOn = req.query.asOn || operationDateKey();
  const todayRange = semanticDateRange(asOn, asOn);
  const asOnDate = todayRange.$gte;
  const maxDays = req.query.days === undefined || req.query.days === '' ? null : Number(req.query.days);
  const until = Number.isFinite(maxDays) ? new Date(asOnDate.getTime() + maxDays * 86400000) : null;

  const rows = batches.map((batch) => {
    const medicine = medicineMap.get(String(batch.medicine_id));
    if (!medicine) return null;
    const expiry = new Date(batch.expiry_date);
    if (until && expiry > until) return null;
    const stock = Number(batch.quantity_base_units ?? batch.quantity ?? 0);
    if (stock <= 0 && req.query.includeZero !== 'true') return null;
    const rate = Number(batch.purchase_price_per_base_unit ?? ((batch.purchase_price_per_pack || batch.purchase_price || 0) / (batch.units_per_pack || 1)) ?? 0);
    const days = Math.ceil((expiry.getTime() - asOnDate.getTime()) / 86400000);
    return {
      itemName: medicine.name,
      categoryName: medicine.category || 'Uncategorised',
      partyName: batch.supplier_id?.name || batch.supplier_id?.supplier_name || batch.supplier_id?.company_name || '',
      batchNumber: batch.batch_number,
      expiryDate: expiry,
      currentStock: stock,
      openingRate: normalizeMoney(rate),
      totalValue: normalizeMoney(stock * rate),
      days,
      medicineId: medicine._id,
      batchId: batch._id,
    };
  }).filter(Boolean).sort((a, b) => a.expiryDate - b.expiryDate || a.itemName.localeCompare(b.itemName));

  res.json({ success: true, asOn, rows, totals: { items: rows.length, value: normalizeMoney(rows.reduce((s, r) => s + r.totalValue, 0)) } });
});

exports.getSalesPatientWise = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const selectedDay = operationDateKey();
  const range = semanticDateRange(req.query.startDate || selectedDay, req.query.endDate || selectedDay);
  const query = { hospitalId, sale_date: range, status: { $ne: 'Cancelled' } };
  if (req.query.patientId) query.patient_id = objectIdOrUndefined(req.query.patientId);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const skip = (page - 1) * limit;

  const [sales, total] = await Promise.all([
    Sale.find(query)
      .populate('patient_id', 'first_name last_name patientId uhid phone')
      .populate('doctor_id', 'firstName lastName name')
      .populate({ path: 'appointment_id', select: 'appointmentId department_id', populate: { path: 'department_id', select: 'name department_name' } })
      .populate({ path: 'admission_id', select: 'admissionNumber shipNumber departmentId', populate: { path: 'departmentId', select: 'name department_name' } })
      .populate('items.medicine_id', 'name category')
      .populate('items.batch_id', 'batch_number expiry_date')
      .sort({ sale_date: 1, sale_number: 1 })
      .skip(skip).limit(limit).lean(),
    Sale.countDocuments(query),
  ]);

  const saleIds = sales.map((sale) => sale._id);
  const returns = saleIds.length ? await PharmacyReturn.find({ hospitalId, originalSaleId: { $in: saleIds }, status: 'Completed' }).lean() : [];
  const returnsBySale = new Map();
  for (const ret of returns) {
    const key = String(ret.originalSaleId);
    if (!returnsBySale.has(key)) returnsBySale.set(key, []);
    returnsBySale.get(key).push(ret);
  }

  const rows = sales.map((sale) => ({
    saleId: sale._id,
    billNo: sale.sale_number || sale.invoice_number,
    invoiceNo: sale.invoice_number,
    billDate: sale.sale_date,
    patient: sale.patient_id ? {
      _id: sale.patient_id._id,
      name: `${sale.patient_id.first_name || ''} ${sale.patient_id.last_name || ''}`.trim(),
      uhid: sale.uhid || sale.patient_id.uhid || sale.patient_id.patientId,
      phone: sale.patient_id.phone,
    } : { name: sale.customer_name || 'Walk-in', uhid: sale.uhid || '' },
    opNo: sale.appointment_id?.appointmentId || sale.registration_number || '',
    admissionNo: sale.admission_id?.admissionNumber || sale.admission_id?.shipNumber || '',
    department: sale.appointment_id?.department_id?.name || sale.appointment_id?.department_id?.department_name || sale.admission_id?.departmentId?.name || sale.admission_id?.departmentId?.department_name || '',
    consultant: sale.doctor_name || sale.doctor_id?.name || [sale.doctor_id?.firstName, sale.doctor_id?.lastName].filter(Boolean).join(' '),
    items: (sale.items || []).map((item) => ({
      itemName: item.medicine_name || item.medicine_id?.name || '',
      category: item.medicine_id?.category || '',
      batchNo: item.batch_number || item.batch_id?.batch_number || '',
      expiryDate: item.expiry_date || item.batch_id?.expiry_date,
      saleRate: Number(item.rate_per_base_unit ?? item.unit_price ?? 0),
      qty: Number(item.quantity_base_units ?? item.quantity ?? 0),
      discount: Number(item.discount_amount || 0),
      gst: Number(item.tax_amount || 0),
      netAmount: Number(item.net_amount ?? item.total_price ?? 0),
    })),
    totalAmount: Number(sale.total_amount || 0),
    returns: (returnsBySale.get(String(sale._id)) || []).flatMap((ret) => (ret.items || []).map((item) => ({
      returnNo: ret.returnNumber,
      returnDate: ret.returnedAt || ret.createdAt,
      itemName: item.medicineName,
      qty: item.returnedQtyBaseUnits,
      rate: item.ratePerBaseUnit,
      amount: item.refundAmount,
    }))),
  }));

  res.json({ success: true, range: { start: range.$gte, end: range.$lt || range.$lte }, rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
});

exports.getSalesTaxWise = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const selectedDay = operationDateKey();
  const range = semanticDateRange(req.query.startDate || selectedDay, req.query.endDate || selectedDay);
  const sales = await Sale.find({ hospitalId, sale_date: range, status: { $ne: 'Cancelled' } }).lean();
  const returns = await PharmacyReturn.find({ hospitalId, returnedAt: range, status: 'Completed' }).lean();
  const buckets = new Map();

  function bucket(rate) {
    const key = Number(rate || 0).toFixed(2);
    if (!buckets.has(key)) buckets.set(key, { taxRate: Number(key), netAmount: 0, discount: 0, taxableAmount: 0, cgst: 0, sgst: 0, tax: 0, netPayable: 0, returnAmount: 0, returnTax: 0, bills: new Map() });
    return buckets.get(key);
  }

  for (const sale of sales) {
    for (const item of sale.items || []) {
      const b = bucket(item.tax_rate);
      const taxable = Number(item.taxable_amount || 0);
      const tax = Number(item.tax_amount || 0);
      const cgst = Number(item.cgst_amount ?? tax / 2);
      const sgst = Number(item.sgst_amount ?? tax / 2);
      const net = Number(item.net_amount ?? item.total_price ?? taxable + tax);
      b.netAmount += Number(item.gross_amount || 0);
      b.discount += Number(item.discount_amount || 0);
      b.taxableAmount += taxable;
      b.cgst += cgst;
      b.sgst += sgst;
      b.tax += tax;
      b.netPayable += net;
      const billKey = String(sale._id);
      if (!b.bills.has(billKey)) b.bills.set(billKey, { saleId: sale._id, billNo: sale.sale_number || sale.invoice_number, billDate: sale.sale_date, netAmount: 0, discount: 0, cgst: 0, sgst: 0, netPayable: 0 });
      const row = b.bills.get(billKey);
      row.netAmount += Number(item.gross_amount || 0);
      row.discount += Number(item.discount_amount || 0);
      row.cgst += cgst;
      row.sgst += sgst;
      row.netPayable += net;
    }
  }

  for (const ret of returns) {
    for (const item of ret.items || []) {
      const b = bucket(item.taxRate);
      b.returnAmount += Number(item.refundAmount || 0);
      b.returnTax += Number(item.taxAmount || 0);
    }
  }

  const groups = [...buckets.values()].sort((a, b) => a.taxRate - b.taxRate).map((b) => ({
    taxRate: b.taxRate,
    netAmount: normalizeMoney(b.netAmount),
    discount: normalizeMoney(b.discount),
    taxableAmount: normalizeMoney(b.taxableAmount),
    cgst: normalizeMoney(b.cgst),
    sgst: normalizeMoney(b.sgst),
    tax: normalizeMoney(b.tax),
    netPayable: normalizeMoney(b.netPayable),
    returnAmount: normalizeMoney(b.returnAmount),
    returnTax: normalizeMoney(b.returnTax),
    netAfterReturns: normalizeMoney(b.netPayable - b.returnAmount),
    bills: [...b.bills.values()].map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? normalizeMoney(value) : value]))),
  }));

  res.json({ success: true, range: { start: range.$gte, end: range.$lt || range.$lte }, groups, totals: groups.reduce((acc, group) => {
    acc.netAmount += group.netAmount; acc.discount += group.discount; acc.cgst += group.cgst; acc.sgst += group.sgst; acc.tax += group.tax; acc.netPayable += group.netPayable; acc.returnAmount += group.returnAmount; acc.netAfterReturns += group.netAfterReturns; return acc;
  }, { netAmount: 0, discount: 0, cgst: 0, sgst: 0, tax: 0, netPayable: 0, returnAmount: 0, netAfterReturns: 0 }) });
});

exports.getProfitLoss = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const now = operationNow();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const range = (req.query.startDate || req.query.endDate)
    ? semanticDateRange(req.query.startDate, req.query.endDate)
    : { $gte: defaultStart, $lt: new Date(now.getTime() + 1) };

  const [sales, returns] = await Promise.all([
    Sale.find({ hospitalId, sale_date: range, status: { $ne: 'Cancelled' } })
      .select('+total_purchase_cost +gross_profit +items.purchase_rate_per_base_unit +items.purchase_amount +items.gross_profit')
      .lean(),
    PharmacyReturn.find({ hospitalId, returnedAt: range, status: 'Completed' })
      .select('+items.purchaseRatePerBaseUnit')
      .lean(),
  ]);

  const grossSales = sales.reduce((s, sale) => s + Number(sale.total_amount || 0), 0);
  const discounts = sales.reduce((s, sale) => s + Number(sale.discount_amount || 0), 0);
  const salesTax = sales.reduce((s, sale) => s + Number(sale.tax || 0), 0);
  const saleCogs = sales.reduce((sum, sale) => sum + Number(sale.total_purchase_cost || (sale.items || []).reduce((s, item) => s + Number(item.purchase_amount || (Number(item.purchase_rate_per_base_unit || 0) * Number(item.quantity_base_units ?? item.quantity ?? 0))), 0)), 0);
  const totalReturns = returns.reduce((s, ret) => s + Number(ret.totalRefundAmount || 0), 0);
  const returnTax = returns.reduce((s, ret) => s + (ret.items || []).reduce((x, item) => x + Number(item.taxAmount || 0), 0), 0);
  const returnedCogs = returns.reduce((s, ret) => s + (ret.items || []).reduce((x, item) => item.restock === false ? x : x + Number(item.purchaseRatePerBaseUnit || 0) * Number(item.returnedQtyBaseUnits || 0), 0), 0);
  const netRevenue = grossSales - totalReturns;
  const netCogs = Math.max(0, saleCogs - returnedCogs);
  const grossProfit = netRevenue - netCogs;
  const gstNet = Math.max(0, salesTax - returnTax);

  const paymentMethods = {};
  const monthly = {};
  for (const sale of sales) {
    const key = sale.payment_method || 'Unknown';
    paymentMethods[key] = (paymentMethods[key] || 0) + Number(sale.amount_paid || sale.total_amount || 0);
    const monthKey = new Date(sale.sale_date).toISOString().slice(0, 7);
    if (!monthly[monthKey]) monthly[monthKey] = { revenue: 0, cogs: 0, profit: 0, sales: 0 };
    const saleCost = Number(sale.total_purchase_cost || (sale.items || []).reduce((sum, item) => sum + Number(item.purchase_amount || (Number(item.purchase_rate_per_base_unit || 0) * Number(item.quantity_base_units ?? item.quantity ?? 0))), 0));
    monthly[monthKey].revenue += Number(sale.total_amount || 0);
    monthly[monthKey].cogs += saleCost;
    monthly[monthKey].profit += Number(sale.total_amount || 0) - saleCost;
    monthly[monthKey].sales += 1;
  }
  for (const ret of returns) {
    const monthKey = new Date(ret.returnedAt || ret.createdAt).toISOString().slice(0, 7);
    if (!monthly[monthKey]) monthly[monthKey] = { revenue: 0, cogs: 0, profit: 0, sales: 0 };
    const refund = Number(ret.totalRefundAmount || 0);
    const restockedCost = (ret.items || []).reduce((sum, item) => item.restock === false ? sum : sum + Number(item.purchaseRatePerBaseUnit || 0) * Number(item.returnedQtyBaseUnits || 0), 0);
    monthly[monthKey].revenue -= refund;
    monthly[monthKey].cogs -= restockedCost;
    monthly[monthKey].profit -= (refund - restockedCost);
  }

  res.json({
    success: true,
    range: { start: range.$gte, end: range.$lt || range.$lte },
    period: { start: range.$gte, end: range.$lt || range.$lte, label: `${req.query.startDate || ''}${req.query.endDate ? ` to ${req.query.endDate}` : ''}` },
    revenue: { total: normalizeMoney(grossSales), fromSales: normalizeMoney(grossSales), fromReturns: normalizeMoney(totalReturns), discounts: normalizeMoney(discounts), netRevenue: normalizeMoney(netRevenue), salesCount: sales.length, returnCount: returns.length, averageOrderValue: sales.length ? normalizeMoney(netRevenue / sales.length) : 0 },
    cogs: { total: normalizeMoney(netCogs), returnedCost: normalizeMoney(returnedCogs), percentage: netRevenue ? normalizeMoney((netCogs / netRevenue) * 100) : 0 },
    grossProfit: { amount: normalizeMoney(grossProfit), margin: netRevenue ? normalizeMoney((grossProfit / netRevenue) * 100) : 0, perTransaction: sales.length ? normalizeMoney(grossProfit / sales.length) : 0 },
    tax: { salesTax: normalizeMoney(salesTax), returnTax: normalizeMoney(returnTax), netTax: normalizeMoney(gstNet) },
    expenses: { tax: normalizeMoney(gstNet), operatingExpenses: 0, totalExpenses: 0 },
    netProfit: { amount: normalizeMoney(grossProfit), margin: netRevenue ? normalizeMoney((grossProfit / netRevenue) * 100) : 0, note: 'Pharmacy gross profit before non-inventory operating expenses.' },
    paymentMethods: Object.entries(paymentMethods).map(([method, amount]) => ({ method, amount: normalizeMoney(amount), percentage: netRevenue ? normalizeMoney((amount / netRevenue) * 100) : 0 })),
    monthlyData: Object.entries(monthly).map(([month, row]) => ({ month, revenue: normalizeMoney(row.revenue), cogs: normalizeMoney(row.cogs), profit: normalizeMoney(row.profit), sales: row.sales })).sort((a, b) => a.month.localeCompare(b.month)),
  });
});

exports.exportDoctorBills = asyncHandler(async (req, res) => {
  const hospitalId = requireHospital(req);
  const now = operationNow();
  const defaultStart = new Date(now.getTime() - 30 * 86400000);
  const range = (req.query.startDate || req.query.endDate) ? semanticDateRange(req.query.startDate, req.query.endDate) : { $gte: defaultStart, $lte: now };
  const match = { hospitalId, sale_date: range, status: { $ne: 'Cancelled' } };
  if (req.query.doctorId) match.doctor_id = objectIdOrUndefined(req.query.doctorId);
  const sales = await Sale.find(match).populate('doctor_id', 'firstName lastName name').populate('patient_id', 'first_name last_name uhid patientId').sort({ sale_date: 1 }).lean();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Doctor Bills');
  sheet.columns = [
    { header: 'Date', key: 'date', width: 14 }, { header: 'Sale No', key: 'sale', width: 22 }, { header: 'Patient', key: 'patient', width: 26 }, { header: 'UHID', key: 'uhid', width: 18 }, { header: 'Doctor', key: 'doctor', width: 28 }, { header: 'Total', key: 'total', width: 14 }, { header: 'Discount', key: 'discount', width: 14 }, { header: 'GST', key: 'tax', width: 14 }, { header: 'Paid', key: 'paid', width: 14 }, { header: 'Balance', key: 'balance', width: 14 },
  ];
  for (const sale of sales) {
    sheet.addRow({
      date: new Date(sale.sale_date).toLocaleDateString('en-IN'), sale: sale.sale_number || sale.invoice_number || '',
      patient: sale.patient_id ? `${sale.patient_id.first_name || ''} ${sale.patient_id.last_name || ''}`.trim() : (sale.customer_name || 'Walk-in'),
      uhid: sale.uhid || sale.patient_id?.uhid || sale.patient_id?.patientId || '',
      doctor: sale.doctor_name || sale.doctor_id?.name || [sale.doctor_id?.firstName, sale.doctor_id?.lastName].filter(Boolean).join(' '),
      total: sale.total_amount || 0, discount: sale.discount_amount || 0, tax: sale.tax || 0, paid: sale.amount_paid || 0, balance: sale.balance_due || 0,
    });
  }
  sheet.getRow(1).font = { bold: true };
  ['F', 'G', 'H', 'I', 'J'].forEach((col) => { sheet.getColumn(col).numFmt = '#,##0.00'; });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="doctor_bills_${operationDateKey()}.xlsx"`);
  res.send(Buffer.from(buffer));
});
