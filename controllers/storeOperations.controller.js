const mongoose = require('mongoose');
const StoreLocation = require('../models/StoreLocation');
const InventoryLot = require('../models/InventoryLot');
const StockReservation = require('../models/StockReservation');
const GoodsReceiptNote = require('../models/GoodsReceiptNote');
const StoreIssueReturn = require('../models/StoreIssueReturn');
const StockTransfer = require('../models/StockTransfer');
const StockCount = require('../models/StockCount');
const PurchaseReturn = require('../models/PurchaseReturn');
const StoreIssue = require('../models/StoreIssue');
const StorePurchaseOrder = require('../models/StorePurchaseOrder');
const StoreItem = require('../models/StoreItem');
const OTRequest = require('../models/OTRequest');
const inventory = require('../services/inventoryLedger.service');
const { nextSequence, financialYear } = require('../services/hospitalSequence.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

const populateLot = (query) => query
  .populate('itemId', 'item_code name unit category current_stock average_cost tracking_policy')
  .populate('locationBalances.locationId', 'code name type');

function nextNumber(hospitalId, key, prefix, session) {
  return nextSequence(hospitalId, key, session).then((value) => `${prefix}/${financialYear()}/${String(value).padStart(6, '0')}`);
}

function listFilter(req, extra = {}) {
  const filter = { hospitalId: requireHospitalId(req), ...extra };
  if (req.query.status) filter.status = req.query.status;
  return filter;
}

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  return { page, limit, skip: (page - 1) * limit };
}

async function paged(model, filter, req, populate) {
  const { page, limit, skip } = parsePaging(req);
  let query = model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  if (populate) query = populate(query);
  const [data, total] = await Promise.all([query, model.countDocuments(filter)]);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

function ensureLines(body) {
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    const error = new Error('At least one line is required');
    error.statusCode = 400;
    throw error;
  }
}

exports.listLocations = async (req, res, next) => {
  try {
    const filter = { hospitalId: requireHospitalId(req) };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.active !== undefined) filter.isActive = req.query.active === 'true';
    const data = await StoreLocation.find(filter).populate('parentLocationId departmentId wardId roomId responsibleUserId', 'name code room_number email').sort({ type: 1, code: 1 });
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.createLocation = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await StoreLocation.create({ ...req.body, hospitalId, createdBy: req.user._id });
    await appendDomainEvent({ req, eventType: 'store.location.created', entityType: 'StoreLocation', entityId: data._id, hospitalId, afterSummary: { code: data.code, name: data.name, type: data.type } });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.updateLocation = async (req, res, next) => {
  try {
    const data = await StoreLocation.findOneAndUpdate({ _id: req.params.id, hospitalId: requireHospitalId(req) }, { $set: req.body }, { new: true, runValidators: true });
    if (!data) return res.status(404).json({ error: 'Store location not found' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.listLots = async (req, res, next) => {
  try {
    const filter = { hospitalId: requireHospitalId(req) };
    for (const key of ['itemId', 'qualityStatus']) if (req.query[key]) filter[key] = req.query[key];
    if (req.query.expiringWithinDays) {
      const end = new Date(); end.setDate(end.getDate() + Number(req.query.expiringWithinDays));
      filter.expiryDate = { $gte: new Date(), $lte: end };
    }
    if (req.query.locationId) filter.locationBalances = { $elemMatch: { locationId: req.query.locationId, onHand: { $gt: 0 } } };
    res.json({ success: true, ...(await paged(InventoryLot, filter, req, populateLot)) });
  } catch (error) { next(error); }
};

exports.listReservations = async (req, res, next) => {
  try {
    const filter = listFilter(req);
    for (const key of ['sourceType', 'sourceId', 'otCaseId', 'patientId', 'admissionId']) if (req.query[key]) filter[key] = req.query[key];
    res.json({ success: true, ...(await paged(StockReservation, filter, req, (q) => q.populate('lines.itemId lines.lotId lines.locationId', 'name item_code lotNumber serialNumber code'))) });
  } catch (error) { next(error); }
};

exports.createReservation = async (req, res, next) => {
  try {
    ensureLines(req.body);
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const reservationNumber = await nextNumber(hospitalId, 'stock-reservation', 'RES', session);
      const [reservation] = await StockReservation.create([{
        hospitalId, reservationNumber, sourceType: req.body.sourceType || (req.body.otCaseId ? 'OTCase' : 'Other'),
        sourceId: req.body.sourceId || req.body.otCaseId || req.body.admissionId,
        admissionId: req.body.admissionId, patientId: req.body.patientId, otCaseId: req.body.otCaseId,
        lines: req.body.lines, expiresAt: req.body.expiresAt, createdBy: req.user._id
      }], { session });
      for (const line of reservation.lines) {
        await inventory.reserve({ hospitalId, lotId: line.lotId, locationId: line.locationId, quantity: line.quantity, referenceId: reservation._id, performedBy: req.user._id, admissionId: reservation.admissionId, patientId: reservation.patientId, otCaseId: reservation.otCaseId, correlationId: reservationNumber, session });
      }
      if (reservation.otCaseId) await OTRequest.updateOne({ _id: reservation.otCaseId, hospitalId }, { $set: { inventoryReservationId: reservation._id, inventoryStatus: 'Reserved' } }, { session });
      await appendDomainEvent({ req, eventType: 'store.stock.reserved', entityType: 'StockReservation', entityId: reservation._id, hospitalId, patientId: reservation.patientId, encounterId: reservation.admissionId, afterSummary: { reservationNumber, lineCount: reservation.lines.length }, session });
      return reservation;
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.releaseReservation = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const reservation = await StockReservation.findOne({ _id: req.params.id, hospitalId, status: { $in: ['Active', 'Partially Issued'] } }).session(session);
      if (!reservation) throw Object.assign(new Error('Active reservation not found'), { statusCode: 404 });
      for (const line of reservation.lines) {
        const remaining = Number(line.quantity) - Number(line.issuedQuantity) - Number(line.releasedQuantity);
        if (remaining > 0) {
          await inventory.releaseReservation({ hospitalId, lotId: line.lotId, locationId: line.locationId, quantity: remaining, referenceId: reservation._id, performedBy: req.user._id, admissionId: reservation.admissionId, patientId: reservation.patientId, otCaseId: reservation.otCaseId, correlationId: reservation.reservationNumber, session });
          line.releasedQuantity += remaining;
        }
      }
      reservation.status = 'Released'; reservation.releasedBy = req.user._id; reservation.releasedAt = new Date(); reservation.releaseReason = req.body.reason;
      await reservation.save({ session });
      return reservation;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.issueReservation = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const reservation = await StockReservation.findOne({ _id: req.params.id, hospitalId, status: { $in: ['Active', 'Partially Issued'] } }).session(session);
      if (!reservation) throw Object.assign(new Error('Active reservation not found'), { statusCode: 404 });
      const selected = new Map((req.body.lines || []).map((line) => [String(line.lineId || line._id), Number(line.quantity)]));
      const issueLines = [];
      for (const line of reservation.lines) {
        const available = Number(line.quantity) - Number(line.issuedQuantity) - Number(line.releasedQuantity);
        const qty = selected.has(String(line._id)) ? selected.get(String(line._id)) : available;
        if (qty <= 0) continue;
        if (qty > available) throw Object.assign(new Error('Issue quantity exceeds reserved quantity'), { statusCode: 409 });
        const movement = await inventory.issue({ hospitalId, lotId: line.lotId, fromLocationId: line.locationId, quantity: qty, consumeReservation: true, toLocationId: req.body.destinationLocationId, referenceModel: 'StockReservation', referenceId: reservation._id, performedBy: req.user._id, admissionId: reservation.admissionId, patientId: reservation.patientId, otCaseId: reservation.otCaseId, correlationId: reservation.reservationNumber, session });
        line.issuedQuantity += qty;
        issueLines.push({ item: line.itemId, lot: line.lotId, from_location: line.locationId, quantity: qty, unit_cost: movement.lot.unitCost });
      }
      if (!issueLines.length) throw Object.assign(new Error('No quantity selected for issue'), { statusCode: 400 });
      const [issue] = await StoreIssue.create([{ department: req.body.department || 'OT', issued_to_name: req.body.issuedToName, requested_by: reservation.createdBy, issued_by: req.user._id, items: issueLines, destination_location: req.body.destinationLocationId, admission_id: reservation.admissionId, patient_id: reservation.patientId, ot_case_id: reservation.otCaseId, reservation_id: reservation._id, status: 'Issued', hospital_id: hospitalId }], { session });
      const complete = reservation.lines.every((line) => Number(line.issuedQuantity) + Number(line.releasedQuantity) >= Number(line.quantity));
      reservation.status = complete ? 'Issued' : 'Partially Issued'; await reservation.save({ session });
      if (reservation.otCaseId) await OTRequest.updateOne({ _id: reservation.otCaseId, hospitalId }, { $set: { inventoryStatus: complete ? 'Issued' : 'Partially Issued' } }, { session });
      return { reservation, issue };
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.listGrns = async (req, res, next) => {
  try { res.json({ success: true, ...(await paged(GoodsReceiptNote, listFilter(req), req, (q) => q.populate('purchaseOrderId lines.itemId lines.lotIds lines.destinationLocationId', 'po_number supplier_name item_code name lotNumber code'))) }); }
  catch (error) { next(error); }
};

exports.createGrn = async (req, res, next) => {
  try {
    ensureLines(req.body);
    const hospitalId = requireHospitalId(req);
    const po = await StorePurchaseOrder.findOne({ _id: req.body.purchaseOrderId, hospital_id: hospitalId });
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const grnNumber = await nextNumber(hospitalId, 'goods-receipt', 'GRN');
    const grn = await GoodsReceiptNote.create({ ...req.body, hospitalId, grnNumber, supplierName: req.body.supplierName || po.supplier_name, receivedBy: req.user._id, status: 'QC Pending' });
    await StorePurchaseOrder.updateOne({ _id: po._id }, { $addToSet: { grn_ids: grn._id }, $set: { status: 'QC Pending' } });
    res.status(201).json({ success: true, data: grn });
  } catch (error) { next(error); }
};

exports.postGrn = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const grn = await GoodsReceiptNote.findOne({ _id: req.params.id, hospitalId, status: { $in: ['QC Pending', 'Partially Posted'] } }).session(session);
      if (!grn) throw Object.assign(new Error('Postable GRN not found'), { statusCode: 404 });
      for (const line of grn.lines) {
        const accepted = Number(line.acceptedQuantity || (line.qcStatus === 'Accepted' ? line.receivedQuantity : 0));
        if (accepted <= 0 || line.lotIds.length) continue;
        const serials = line.serialNumbers?.length ? line.serialNumbers : [null];
        if (serials[0] && accepted !== serials.length) throw Object.assign(new Error('Accepted quantity must match serial number count'), { statusCode: 400 });
        const allocations = serials[0] ? serials.map((serialNumber) => ({ serialNumber, quantity: 1 })) : [{ serialNumber: null, quantity: accepted }];
        for (const allocation of allocations) {
          const movement = await inventory.receive({ hospitalId, itemId: line.itemId, lotData: { lotNumber: line.lotNumber || grn.grnNumber, serialNumber: allocation.serialNumber, manufactureDate: line.manufactureDate, expiryDate: line.expiryDate, qualityStatus: 'Accepted', grnId: grn._id, supplierName: grn.supplierName }, locationId: line.destinationLocationId, quantity: allocation.quantity, unitCost: line.unitCost, referenceId: grn._id, performedBy: req.user._id, correlationId: grn.grnNumber, session });
          line.lotIds.push(movement.lot._id);
        }
        line.qcStatus = Number(line.rejectedQuantity || 0) > 0 ? 'Partially Accepted' : 'Accepted';
      }
      grn.status = 'Posted'; grn.inspectedBy = req.user._id; grn.inspectedAt = new Date(); grn.stockPostedBy = req.user._id; grn.stockPostedAt = new Date(); await grn.save({ session });
      await StorePurchaseOrder.updateOne({ _id: grn.purchaseOrderId, hospital_id: hospitalId }, { $set: { status: 'Received', received_date: new Date(), received_by: req.user._id } }, { session });
      await appendDomainEvent({ req, eventType: 'store.grn.posted', entityType: 'GoodsReceiptNote', entityId: grn._id, hospitalId, afterSummary: { grnNumber: grn.grnNumber }, session });
      return grn;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.listReturns = async (req, res, next) => {
  try { res.json({ success: true, ...(await paged(StoreIssueReturn, listFilter(req), req, (q) => q.populate('issueId lines.itemId lines.lotId lines.locationId', 'issue_number item_code name lotNumber code'))) }); }
  catch (error) { next(error); }
};

exports.createReturn = async (req, res, next) => {
  try {
    ensureLines(req.body);
    const hospitalId = requireHospitalId(req);
    const issue = await StoreIssue.findOne({ _id: req.body.issueId, hospital_id: hospitalId });
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const returnNumber = await nextNumber(hospitalId, 'store-return', 'RET');
    const data = await StoreIssueReturn.create({ ...req.body, hospitalId, returnNumber, admissionId: issue.admission_id, patientId: issue.patient_id, otCaseId: issue.ot_case_id, status: 'Received', receivedBy: req.user._id });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.postReturn = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const record = await StoreIssueReturn.findOne({ _id: req.params.id, hospitalId, status: 'Received' }).session(session);
      if (!record) throw Object.assign(new Error('Return not found or already posted'), { statusCode: 404 });
      for (const line of record.lines) {
        if (line.disposition === 'Write Off') continue;
        await inventory.returnToStock({ hospitalId, lotId: line.lotId, toLocationId: line.locationId, quantity: line.quantity, referenceId: record._id, performedBy: req.user._id, admissionId: record.admissionId, patientId: record.patientId, otCaseId: record.otCaseId, correlationId: record.returnNumber, condition: line.disposition === 'Quarantine' ? 'Damaged' : line.condition, session });
      }
      record.status = 'Posted'; await record.save({ session });
      return record;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.listTransfers = async (req, res, next) => {
  try { res.json({ success: true, ...(await paged(StockTransfer, listFilter(req), req, (q) => q.populate('fromLocationId toLocationId lines.itemId lines.lotId', 'code name item_code lotNumber'))) }); }
  catch (error) { next(error); }
};

exports.createTransfer = async (req, res, next) => {
  try {
    ensureLines(req.body);
    const hospitalId = requireHospitalId(req);
    if (String(req.body.fromLocationId) === String(req.body.toLocationId)) return res.status(400).json({ error: 'Source and destination must be different' });
    const transferNumber = await nextNumber(hospitalId, 'stock-transfer', 'TRF');
    const data = await StockTransfer.create({ ...req.body, hospitalId, transferNumber, requestedBy: req.user._id });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.approveTransfer = async (req, res, next) => {
  try {
    const data = await StockTransfer.findOneAndUpdate({ _id: req.params.id, hospitalId: requireHospitalId(req), status: 'Draft' }, { $set: { status: 'Approved', approvedBy: req.user._id } }, { new: true });
    if (!data) return res.status(404).json({ error: 'Draft transfer not found' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.dispatchTransfer = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const transfer = await StockTransfer.findOne({ _id: req.params.id, hospitalId, status: { $in: ['Approved', 'Picked'] } }).session(session);
      if (!transfer) throw Object.assign(new Error('Approved transfer not found'), { statusCode: 404 });
      for (const line of transfer.lines) await inventory.transfer({ hospitalId, lotId: line.lotId, fromLocationId: transfer.fromLocationId, toLocationId: transfer.toLocationId, quantity: line.dispatchedQuantity, referenceId: transfer._id, performedBy: req.user._id, correlationId: transfer.transferNumber, session });
      transfer.status = 'In Transit'; transfer.dispatchedBy = req.user._id; transfer.dispatchedAt = new Date(); await transfer.save({ session });
      return transfer;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.receiveTransfer = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req), status: 'In Transit' });
    if (!transfer) return res.status(404).json({ error: 'Transfer in transit not found' });
    const received = new Map((req.body.lines || []).map((line) => [String(line.lineId || line._id), line]));
    let discrepancy = false;
    transfer.lines.forEach((line) => {
      const input = received.get(String(line._id));
      line.receivedQuantity = Number(input?.receivedQuantity ?? line.dispatchedQuantity);
      line.damagedQuantity = Number(input?.damagedQuantity || 0);
      line.shortageQuantity = Math.max(0, Number(line.dispatchedQuantity) - line.receivedQuantity - line.damagedQuantity);
      if (line.shortageQuantity || line.damagedQuantity) discrepancy = true;
    });
    transfer.status = discrepancy ? 'Discrepancy' : 'Received'; transfer.receivedBy = req.user._id; transfer.receivedAt = new Date(); await transfer.save();
    res.json({ success: true, data: transfer });
  } catch (error) { next(error); }
};

exports.listCounts = async (req, res, next) => {
  try { res.json({ success: true, ...(await paged(StockCount, listFilter(req), req, (q) => q.populate('locationId lines.itemId lines.lotId', 'code name item_code lotNumber'))) }); }
  catch (error) { next(error); }
};

exports.createCount = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const locationId = req.body.locationId;
    let lots = [];
    if (req.body.lines?.length) {
      lots = req.body.lines;
    } else {
      const records = await InventoryLot.find({ hospitalId, locationBalances: { $elemMatch: { locationId, onHand: { $gte: 0 } } } });
      lots = records.map((lot) => ({ itemId: lot.itemId, lotId: lot._id, systemQuantity: lot.locationBalances.find((row) => String(row.locationId) === String(locationId))?.onHand || 0, countedQuantity: 0 }));
    }
    const countNumber = await nextNumber(hospitalId, 'stock-count', 'CNT');
    const data = await StockCount.create({ hospitalId, countNumber, locationId, scope: req.body.scope || 'Cycle', freezeAt: new Date(), lines: lots, status: 'Counting', countedBy: [req.user._id], notes: req.body.notes });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.updateCount = async (req, res, next) => {
  try {
    const count = await StockCount.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req), status: { $in: ['Counting', 'Review'] } });
    if (!count) return res.status(404).json({ error: 'Open stock count not found' });
    const values = new Map((req.body.lines || []).map((line) => [String(line.lineId || line._id || line.lotId), line]));
    count.lines.forEach((line) => {
      const input = values.get(String(line._id)) || values.get(String(line.lotId));
      if (!input) return;
      line.countedQuantity = Number(input.countedQuantity || 0); line.varianceQuantity = line.countedQuantity - Number(line.systemQuantity || 0); line.reasonCode = input.reasonCode; line.notes = input.notes;
    });
    count.status = req.body.status === 'Review' ? 'Review' : 'Counting'; if (!count.countedBy.some((id) => String(id) === String(req.user._id))) count.countedBy.push(req.user._id); await count.save();
    res.json({ success: true, data: count });
  } catch (error) { next(error); }
};

exports.postCount = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const count = await StockCount.findOne({ _id: req.params.id, hospitalId, status: { $in: ['Review', 'Approved'] } }).session(session);
      if (!count) throw Object.assign(new Error('Reviewed stock count not found'), { statusCode: 404 });
      for (const line of count.lines) {
        const variance = Number(line.varianceQuantity || 0); if (!variance || !line.lotId) continue;
        const lot = await InventoryLot.findOne({ _id: line.lotId, hospitalId }).session(session);
        const item = await StoreItem.findOne({ _id: line.itemId, hospital_id: hospitalId }).session(session);
        if (!lot || !item) continue;
        const balance = lot.locationBalances.find((row) => String(row.locationId) === String(count.locationId));
        if (!balance) continue;
        const before = Number(item.current_stock || 0);
        balance.onHand = Math.max(0, Number(balance.onHand || 0) + variance); await lot.save({ session });
        item.current_stock = Math.max(0, before + variance); await item.save({ session });
        await inventory.appendTransaction({ hospitalId, item, lot, type: 'count_variance', quantity: Math.abs(variance), stockBefore: before, stockAfter: item.current_stock, fromLocation: variance < 0 ? count.locationId : undefined, toLocation: variance > 0 ? count.locationId : undefined, referenceModel: 'StockCount', referenceId: count._id, reasonCode: line.reasonCode, remarks: line.notes, performedBy: req.user._id, session });
      }
      count.status = 'Posted'; count.postedBy = req.user._id; count.postedAt = new Date(); await count.save({ session }); return count;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.listPurchaseReturns = async (req, res, next) => {
  try { res.json({ success: true, ...(await paged(PurchaseReturn, listFilter(req), req, (q) => q.populate('purchaseOrderId grnId lines.itemId lines.lotId lines.locationId', 'po_number grnNumber item_code name lotNumber code'))) }); }
  catch (error) { next(error); }
};

exports.createPurchaseReturn = async (req, res, next) => {
  try {
    ensureLines(req.body);
    const hospitalId = requireHospitalId(req);
    const returnNumber = await nextNumber(hospitalId, 'purchase-return', 'PRT');
    const data = await PurchaseReturn.create({ ...req.body, hospitalId, returnNumber, createdBy: req.user._id });
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
};

exports.dispatchPurchaseReturn = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await inventory.runInTransaction(async (session) => {
      const record = await PurchaseReturn.findOne({ _id: req.params.id, hospitalId, status: { $in: ['Approved', 'Draft'] } }).session(session);
      if (!record) throw Object.assign(new Error('Purchase return not found'), { statusCode: 404 });
      for (const line of record.lines) await inventory.issue({ hospitalId, lotId: line.lotId, fromLocationId: line.locationId, quantity: line.quantity, referenceModel: 'PurchaseReturn', referenceId: record._id, performedBy: req.user._id, correlationId: record.returnNumber, reasonCode: line.reason, session });
      record.status = 'Dispatched'; record.approvedBy = req.user._id; record.dispatchedAt = new Date(); await record.save({ session }); return record;
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.getStockPosition = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const [summary, expiring, quarantined] = await Promise.all([
      InventoryLot.aggregate([{ $match: { hospitalId: new mongoose.Types.ObjectId(hospitalId) } }, { $group: { _id: null, onHand: { $sum: '$totalOnHand' }, reserved: { $sum: '$totalReserved' }, available: { $sum: '$totalAvailable' }, lots: { $sum: 1 } } }]),
      InventoryLot.countDocuments({ hospitalId, expiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 90 * 86400000) }, totalOnHand: { $gt: 0 } }),
      InventoryLot.countDocuments({ hospitalId, qualityStatus: { $in: ['Quarantined', 'Rejected', 'Recalled'] }, totalOnHand: { $gt: 0 } })
    ]);
    res.json({ success: true, data: { ...(summary[0] || { onHand: 0, reserved: 0, available: 0, lots: 0 }), expiringWithin90Days: expiring, quarantinedLots: quarantined } });
  } catch (error) { next(error); }
};
