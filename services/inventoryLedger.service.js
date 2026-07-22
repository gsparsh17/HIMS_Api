const crypto = require('crypto');
const mongoose = require('mongoose');
const StoreItem = require('../models/StoreItem');
const InventoryLot = require('../models/InventoryLot');
const StoreInventoryTransaction = require('../models/StoreInventoryTransaction');

function makeEventId() {
  return `inv_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

async function runInTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function locationBalance(lot, locationId, create = false) {
  const id = String(locationId);
  let balance = lot.locationBalances.find((row) => String(row.locationId) === id);
  if (!balance && create) {
    lot.locationBalances.push({ locationId, onHand: 0, reserved: 0, available: 0, lastMovementAt: new Date() });
    balance = lot.locationBalances[lot.locationBalances.length - 1];
  }
  return balance;
}

function validateUsableLot(lot, { allowPendingQc = false } = {}) {
  const allowed = allowPendingQc ? ['Pending QC', 'Accepted'] : ['Accepted'];
  if (!allowed.includes(lot.qualityStatus)) {
    const error = new Error(`Lot cannot be used while quality status is ${lot.qualityStatus}`);
    error.statusCode = 409;
    throw error;
  }
  if (lot.expiryDate && new Date(lot.expiryDate) < new Date()) {
    const error = new Error('Expired stock cannot be issued');
    error.statusCode = 409;
    throw error;
  }
}

async function appendTransaction({ hospitalId, item, lot, type, quantity, stockBefore, stockAfter, unitCost, fromLocation, toLocation, referenceModel, referenceId, admissionId, patientId, otCaseId, correlationId, idempotencyKey, reasonCode, remarks, performedBy, session }) {
  const [transaction] = await StoreInventoryTransaction.create([{
    eventId: makeEventId(),
    item: item._id,
    lot: lot?._id,
    serial_number: lot?.serialNumber,
    from_location: fromLocation,
    to_location: toLocation,
    transaction_type: type,
    quantity,
    stock_before: stockBefore,
    stock_after: stockAfter,
    unit_cost: unitCost || lot?.unitCost || item.average_cost || 0,
    total_cost: number(quantity) * number(unitCost || lot?.unitCost || item.average_cost),
    reference_model: referenceModel || 'Manual',
    reference_id: referenceId,
    admission_id: admissionId,
    patient_id: patientId,
    ot_case_id: otCaseId,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    reason_code: reasonCode,
    remarks,
    hospital_id: hospitalId,
    performed_by: performedBy
  }], { session });
  return transaction;
}

async function receive({ hospitalId, itemId, lotData, locationId, quantity, unitCost, referenceModel = 'GoodsReceiptNote', referenceId, performedBy, correlationId, session }) {
  const qty = number(quantity);
  if (qty <= 0) throw Object.assign(new Error('Receive quantity must be greater than zero'), { statusCode: 400 });
  const item = await StoreItem.findOne({ _id: itemId, hospital_id: hospitalId }).session(session);
  if (!item) throw Object.assign(new Error('Store item not found'), { statusCode: 404 });

  let lot = await InventoryLot.findOne({
    hospitalId,
    itemId,
    lotNumber: lotData.lotNumber || null,
    serialNumber: lotData.serialNumber || null
  }).session(session);
  if (!lot) {
    [lot] = await InventoryLot.create([{
      hospitalId,
      itemId,
      ...lotData,
      unitCost: number(unitCost),
      qualityStatus: lotData.qualityStatus || 'Accepted',
      locationBalances: []
    }], { session });
  }

  const before = number(item.current_stock);
  const balance = locationBalance(lot, locationId, true);
  balance.onHand = number(balance.onHand) + qty;
  balance.lastMovementAt = new Date();
  await lot.save({ session });

  item.current_stock = before + qty;
  const oldValue = before * number(item.average_cost);
  item.average_cost = item.current_stock > 0 ? (oldValue + qty * number(unitCost)) / item.current_stock : number(unitCost);
  item.last_purchase_price = number(unitCost);
  await item.save({ session });

  const transaction = await appendTransaction({
    hospitalId, item, lot, type: 'purchase', quantity: qty, stockBefore: before, stockAfter: item.current_stock,
    unitCost, toLocation: locationId, referenceModel, referenceId, performedBy, correlationId, session
  });
  return { item, lot, transaction };
}

async function reserve({ hospitalId, lotId, locationId, quantity, referenceId, referenceModel = 'StockReservation', performedBy, admissionId, patientId, otCaseId, correlationId, session }) {
  const qty = number(quantity);
  const lot = await InventoryLot.findOne({ _id: lotId, hospitalId }).session(session);
  if (!lot) throw Object.assign(new Error('Inventory lot not found'), { statusCode: 404 });
  validateUsableLot(lot);
  const item = await StoreItem.findOne({ _id: lot.itemId, hospital_id: hospitalId }).session(session);
  const balance = locationBalance(lot, locationId);
  if (!balance || number(balance.available) < qty) throw Object.assign(new Error('Insufficient available quantity for reservation'), { statusCode: 409 });
  balance.reserved = number(balance.reserved) + qty;
  balance.lastMovementAt = new Date();
  await lot.save({ session });
  const transaction = await appendTransaction({
    hospitalId, item, lot, type: 'reservation', quantity: qty, stockBefore: item.current_stock, stockAfter: item.current_stock,
    fromLocation: locationId, referenceModel, referenceId, performedBy, admissionId, patientId, otCaseId, correlationId, session
  });
  return { item, lot, transaction };
}

async function releaseReservation({ hospitalId, lotId, locationId, quantity, referenceId, referenceModel = 'StockReservation', performedBy, admissionId, patientId, otCaseId, correlationId, session }) {
  const qty = number(quantity);
  const lot = await InventoryLot.findOne({ _id: lotId, hospitalId }).session(session);
  if (!lot) throw Object.assign(new Error('Inventory lot not found'), { statusCode: 404 });
  const item = await StoreItem.findOne({ _id: lot.itemId, hospital_id: hospitalId }).session(session);
  const balance = locationBalance(lot, locationId);
  if (!balance || number(balance.reserved) < qty) throw Object.assign(new Error('Release quantity exceeds reserved quantity'), { statusCode: 409 });
  balance.reserved = number(balance.reserved) - qty;
  balance.lastMovementAt = new Date();
  await lot.save({ session });
  const transaction = await appendTransaction({
    hospitalId, item, lot, type: 'reservation_release', quantity: qty, stockBefore: item.current_stock, stockAfter: item.current_stock,
    fromLocation: locationId, referenceModel, referenceId, performedBy, admissionId, patientId, otCaseId, correlationId, session
  });
  return { item, lot, transaction };
}

async function issue({ hospitalId, lotId, fromLocationId, quantity, consumeReservation = false, toLocationId, referenceModel = 'StoreIssue', referenceId, performedBy, admissionId, patientId, otCaseId, correlationId, reasonCode, session }) {
  const qty = number(quantity);
  if (qty <= 0) throw Object.assign(new Error('Issue quantity must be greater than zero'), { statusCode: 400 });
  const lot = await InventoryLot.findOne({ _id: lotId, hospitalId }).session(session);
  if (!lot) throw Object.assign(new Error('Inventory lot not found'), { statusCode: 404 });
  validateUsableLot(lot);
  const item = await StoreItem.findOne({ _id: lot.itemId, hospital_id: hospitalId }).session(session);
  if (!item) throw Object.assign(new Error('Store item not found'), { statusCode: 404 });
  const balance = locationBalance(lot, fromLocationId);
  if (!balance || number(balance.onHand) < qty) throw Object.assign(new Error('Insufficient on-hand quantity'), { statusCode: 409 });
  if (!consumeReservation && number(balance.available) < qty) throw Object.assign(new Error('Quantity is reserved and unavailable'), { statusCode: 409 });
  if (consumeReservation && number(balance.reserved) < qty) throw Object.assign(new Error('Issue quantity exceeds reservation'), { statusCode: 409 });

  const before = number(item.current_stock);
  balance.onHand = number(balance.onHand) - qty;
  if (consumeReservation) balance.reserved = number(balance.reserved) - qty;
  balance.lastMovementAt = new Date();
  await lot.save({ session });
  item.current_stock = Math.max(0, before - qty);
  await item.save({ session });
  const transaction = await appendTransaction({
    hospitalId, item, lot, type: otCaseId ? 'consume' : 'issue', quantity: qty, stockBefore: before, stockAfter: item.current_stock,
    fromLocation: fromLocationId, toLocation: toLocationId, referenceModel, referenceId, performedBy,
    admissionId, patientId, otCaseId, correlationId, reasonCode, session
  });
  return { item, lot, transaction };
}

async function returnToStock({ hospitalId, lotId, toLocationId, quantity, referenceModel = 'StoreIssueReturn', referenceId, performedBy, admissionId, patientId, otCaseId, correlationId, condition = 'Unused', session }) {
  const qty = number(quantity);
  if (qty <= 0) throw Object.assign(new Error('Return quantity must be greater than zero'), { statusCode: 400 });
  const lot = await InventoryLot.findOne({ _id: lotId, hospitalId }).session(session);
  if (!lot) throw Object.assign(new Error('Inventory lot not found'), { statusCode: 404 });
  const item = await StoreItem.findOne({ _id: lot.itemId, hospital_id: hospitalId }).session(session);
  const before = number(item.current_stock);
  const balance = locationBalance(lot, toLocationId, true);
  balance.onHand = number(balance.onHand) + qty;
  balance.lastMovementAt = new Date();
  if (!['Unused', 'Opened Usable'].includes(condition)) lot.qualityStatus = 'Quarantined';
  await lot.save({ session });
  item.current_stock = before + qty;
  await item.save({ session });
  const transaction = await appendTransaction({
    hospitalId, item, lot, type: 'return', quantity: qty, stockBefore: before, stockAfter: item.current_stock,
    toLocation: toLocationId, referenceModel, referenceId, performedBy, admissionId, patientId, otCaseId, correlationId, session
  });
  return { item, lot, transaction };
}

async function transfer({ hospitalId, lotId, fromLocationId, toLocationId, quantity, referenceId, performedBy, correlationId, session }) {
  const qty = number(quantity);
  const lot = await InventoryLot.findOne({ _id: lotId, hospitalId }).session(session);
  if (!lot) throw Object.assign(new Error('Inventory lot not found'), { statusCode: 404 });
  validateUsableLot(lot);
  const item = await StoreItem.findOne({ _id: lot.itemId, hospital_id: hospitalId }).session(session);
  const from = locationBalance(lot, fromLocationId);
  const to = locationBalance(lot, toLocationId, true);
  if (!from || number(from.available) < qty) throw Object.assign(new Error('Insufficient transferable quantity'), { statusCode: 409 });
  from.onHand = number(from.onHand) - qty;
  from.lastMovementAt = new Date();
  to.onHand = number(to.onHand) + qty;
  to.lastMovementAt = new Date();
  await lot.save({ session });
  const out = await appendTransaction({ hospitalId, item, lot, type: 'transfer_out', quantity: qty, stockBefore: item.current_stock, stockAfter: item.current_stock, fromLocation: fromLocationId, toLocation: toLocationId, referenceModel: 'StockTransfer', referenceId, performedBy, correlationId, session });
  const incoming = await appendTransaction({ hospitalId, item, lot, type: 'transfer_in', quantity: qty, stockBefore: item.current_stock, stockAfter: item.current_stock, fromLocation: fromLocationId, toLocation: toLocationId, referenceModel: 'StockTransfer', referenceId, performedBy, correlationId, session });
  return { item, lot, transactions: [out, incoming] };
}

async function selectLotsFEFO({ hospitalId, itemId, locationId, quantity, session }) {
  let remaining = number(quantity);
  const lots = await InventoryLot.find({
    hospitalId,
    itemId,
    qualityStatus: 'Accepted',
    $or: [{ expiryDate: null }, { expiryDate: { $gte: new Date() } }],
    locationBalances: { $elemMatch: { locationId, available: { $gt: 0 } } }
  }).sort({ expiryDate: 1, createdAt: 1 }).session(session);
  const allocations = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const balance = locationBalance(lot, locationId);
    const allocated = Math.min(number(balance.available), remaining);
    if (allocated > 0) allocations.push({ lot, quantity: allocated });
    remaining -= allocated;
  }
  if (remaining > 0) throw Object.assign(new Error('Insufficient eligible stock'), { statusCode: 409 });
  return allocations;
}

module.exports = {
  runInTransaction,
  receive,
  reserve,
  releaseReservation,
  issue,
  returnToStock,
  transfer,
  selectLotsFEFO,
  appendTransaction,
  validateUsableLot
};
