const mongoose = require('mongoose');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const StoreItem = require('../models/StoreItem');
const InventoryLot = require('../models/InventoryLot');
const IPDCharge = require('../models/IPDCharge');
const inventory = require('./inventoryLedger.service');
const ipdFinancial = require('./ipdFinancial.service');

const qty = (value) => Math.max(0, Number(value || 0));
const money = (value) => Number(Number(value || 0).toFixed(2));

function lineKey(line = {}) {
  return line._id ? String(line._id) : `${line.itemId || ''}:${line.lotId || ''}:${line.serialNumber || ''}`;
}

function validateLine(line) {
  const issued = qty(line.issuedQuantity);
  const used = qty(line.usedQuantity);
  const wasted = qty(line.wastedQuantity);
  const returned = qty(line.returnedQuantity);
  if (!line.itemId) throw Object.assign(new Error('Every OT inventory line requires an item'), { statusCode: 400 });
  if ((qty(line.reservedQuantity) || issued || used || wasted || returned) > 0 && !line.lotId) {
    throw Object.assign(new Error('Lot/batch is required for OT stock movement'), { statusCode: 400 });
  }
  if (used + wasted + returned > issued + 1e-9) {
    throw Object.assign(new Error('Used + wasted + returned quantity cannot exceed issued quantity'), { statusCode: 409 });
  }
}

async function loadItemAndLot(hospitalId, line, session) {
  const [item, lot] = await Promise.all([
    StoreItem.findOne({ _id: line.itemId, hospital_id: hospitalId }).session(session),
    line.lotId ? InventoryLot.findOne({ _id: line.lotId, hospitalId }).session(session) : null
  ]);
  if (!item) throw Object.assign(new Error('OT inventory item not found'), { statusCode: 404 });
  if (line.lotId && !lot) throw Object.assign(new Error('OT inventory lot not found'), { statusCode: 404 });
  if (lot && String(lot.itemId) !== String(item._id)) throw Object.assign(new Error('Selected lot does not belong to the selected item'), { statusCode: 409 });
  return { item, lot };
}

async function moveLine({ otCase, usage, oldLine = {}, newLine, sourceLocationId, user, session }) {
  validateLine(newLine);
  const { item, lot } = await loadItemAndLot(otCase.hospitalId, newLine, session);
  const transactions = [];
  const oldReserved = qty(oldLine.reservedQuantity);
  const oldIssued = qty(oldLine.issuedQuantity);
  const oldReturned = qty(oldLine.returnedQuantity);
  const newReserved = qty(newLine.reservedQuantity);
  const newIssued = qty(newLine.issuedQuantity);
  const newReturned = qty(newLine.returnedQuantity);
  if (newReserved < oldReserved || newIssued < oldIssued || newReturned < oldReturned) {
    throw Object.assign(new Error('Posted OT inventory quantities cannot be reduced; use return/reconciliation quantities instead'), { statusCode: 409 });
  }
  if ((newReserved > oldReserved || newIssued > oldIssued || newReturned > oldReturned) && !sourceLocationId) {
    throw Object.assign(new Error('Source store/location is required before posting OT stock movements'), { statusCode: 400 });
  }

  const referenceId = otCase._id;
  const correlationId = `OT:${otCase._id}:inventory:${lineKey(newLine)}`;
  const common = {
    hospitalId: otCase.hospitalId,
    performedBy: user._id,
    admissionId: otCase.admissionId,
    patientId: otCase.patientId,
    otCaseId: otCase._id,
    referenceId,
    referenceModel: 'OTRequest',
    correlationId,
    session
  };

  const reserveDelta = money(newReserved - oldReserved);
  if (reserveDelta > 0) {
    const movement = await inventory.reserve({ ...common, lotId: lot._id, locationId: sourceLocationId, quantity: reserveDelta });
    transactions.push(movement.transaction._id);
  }

  const issueDelta = money(newIssued - oldIssued);
  if (issueDelta > 0) {
    const outstandingReservedBefore = Math.max(0, oldReserved - oldIssued - qty(oldLine.releasedReservationQuantity));
    const newlyReserved = reserveDelta;
    const reservableIssue = Math.min(issueDelta, outstandingReservedBefore + newlyReserved);
    if (reservableIssue > 0) {
      const movement = await inventory.issue({ ...common, lotId: lot._id, fromLocationId: sourceLocationId, quantity: reservableIssue, consumeReservation: true });
      transactions.push(movement.transaction._id);
    }
    const directIssue = money(issueDelta - reservableIssue);
    if (directIssue > 0) {
      const movement = await inventory.issue({ ...common, lotId: lot._id, fromLocationId: sourceLocationId, quantity: directIssue, consumeReservation: false });
      transactions.push(movement.transaction._id);
    }
  }

  const returnDelta = money(newReturned - oldReturned);
  if (returnDelta > 0) {
    const movement = await inventory.returnToStock({ ...common, lotId: lot._id, toLocationId: sourceLocationId, quantity: returnDelta, condition: 'Unused' });
    transactions.push(movement.transaction._id);
  }

  return {
    item,
    lot,
    transactions,
    line: {
      ...newLine,
      itemSnapshot: { _id: item._id, item_code: item.item_code, name: item.name, item_type: item.item_type, unit: item.unit },
      unitCost: money(newLine.unitCost || lot?.unitCost || item.average_cost || 0),
      inventoryTransactionIds: [...new Set([...(oldLine.inventoryTransactionIds || []).map(String), ...transactions.map(String)])]
    }
  };
}

async function postBillingForReconciledUsage({ otCase, usage, user }) {
  let changed = false;
  for (const line of usage.lines) {
    const used = qty(line.usedQuantity);
    const rate = money(line.patientCharge);
    if (used <= 0 || rate <= 0) {
      if (line.billingStatus !== 'Not Required') { line.billingStatus = 'Not Required'; changed = true; }
      continue;
    }
    const key = `OT:${otCase._id}:inventory:${line._id}`;
    let charge = await IPDCharge.findOne({ hospitalId: otCase.hospitalId, idempotencyKey: key });
    if (!charge) {
      try {
        charge = await ipdFinancial.addManualCharge({
          admissionId: otCase.admissionId,
          chargeType: line.itemSnapshot?.item_type === 'asset' || line.serialNumber ? 'Equipment' : 'Miscellaneous',
          serviceType: line.serialNumber ? 'operation_theatre_implant' : 'operation_theatre_consumable',
          description: `${line.itemSnapshot?.name || 'OT item'}${line.serialNumber ? ` · Serial ${line.serialNumber}` : ''}`,
          quantity: used,
          rate,
          sourceModule: 'OT',
          sourceId: otCase._id,
          sourceReference: { module: 'OT', documentId: usage._id, lineKey: key },
          idempotencyKey: key,
          allowStandardFallback: true,
          notes: line.notes || 'OT inventory consumption'
        }, user);
      } catch (error) {
        line.billingStatus = 'Failed';
        changed = true;
        throw error;
      }
    }
    line.billingChargeId = charge._id;
    line.billingStatus = Number(charge.packageAbsorbedAmount || charge.pricingSnapshot?.amounts?.packageAbsorbed || 0) > 0
      && Number(charge.patientLiability || 0) === 0 && Number(charge.sponsorLiability || 0) === 0
      ? 'Package Covered'
      : 'Posted';
    changed = true;
  }
  if (changed) await usage.save();
  return usage;
}

async function saveInventoryUsage({ otCase, payload = {}, user }) {
  let session;
  try {
    session = await mongoose.startSession();
    let usage;
    await session.withTransaction(async () => {
      usage = await OTCaseInventoryUsage.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id }).session(session);
      if (!usage) {
        const rows = await OTCaseInventoryUsage.create([{
          hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId,
          sourceLocationId: payload.sourceLocationId || undefined, lines: [], status: 'Planned'
        }], { session });
        usage = rows[0];
      }
      if (usage.status === 'Reconciled') throw Object.assign(new Error('Reconciled OT inventory is locked; use an audited correction workflow instead of editing it'), { statusCode: 409 });

      const sourceLocationId = payload.sourceLocationId || usage.sourceLocationId;
      const oldMap = new Map((usage.lines || []).map((line) => [lineKey(line), line.toObject ? line.toObject() : line]));
      const nextLines = [];
      for (const raw of Array.isArray(payload.lines) ? payload.lines : []) {
        const line = { ...raw };
        const key = lineKey(line);
        const oldLine = oldMap.get(key) || {};
        const moved = await moveLine({ otCase, usage, oldLine, newLine: line, sourceLocationId, user, session });
        const lineObject = moved.line;
        if (!lineObject._id && raw._id) lineObject._id = raw._id;
        nextLines.push(lineObject);
      }

      const requestedStatus = payload.status || usage.status || 'Planned';
      if (requestedStatus === 'Reconciled') {
        for (const line of nextLines) {
          const issued = qty(line.issuedQuantity);
          const accounted = qty(line.usedQuantity) + qty(line.wastedQuantity) + qty(line.returnedQuantity);
          if (Math.abs(issued - accounted) > 1e-9) {
            throw Object.assign(new Error(`Inventory line ${line.itemSnapshot?.name || line.itemId} is not reconciled: issued ${issued}, accounted ${accounted}`), { statusCode: 409 });
          }
          const unreleased = Math.max(0, qty(line.reservedQuantity) - issued - qty(line.releasedReservationQuantity));
          if (unreleased > 0 && line.lotId) {
            const movement = await inventory.releaseReservation({
              hospitalId: otCase.hospitalId, lotId: line.lotId, locationId: sourceLocationId, quantity: unreleased,
              referenceId: usage._id, referenceModel: 'OTRequest', performedBy: user._id,
              admissionId: otCase.admissionId, patientId: otCase.patientId, otCaseId: otCase._id,
              correlationId: `OT:${otCase._id}:inventory:${lineKey(line)}:release`, session
            });
            line.releasedReservationQuantity = qty(line.releasedReservationQuantity) + unreleased;
            line.inventoryTransactionIds = [...new Set([...(line.inventoryTransactionIds || []).map(String), String(movement.transaction._id)])];
          }
          line.reconciliationStatus = 'Reconciled';
        }
      }

      usage.sourceLocationId = sourceLocationId;
      usage.lines = nextLines;
      usage.status = requestedStatus;
      usage.notes = payload.notes;
      usage.totalCost = money(nextLines.reduce((sum, line) => sum + qty(line.usedQuantity) * money(line.unitCost), 0));
      usage.totalPatientCharge = money(nextLines.reduce((sum, line) => sum + qty(line.usedQuantity) * money(line.patientCharge), 0));
      usage.reconciliationSummary = {
        issued: nextLines.reduce((sum, line) => sum + qty(line.issuedQuantity), 0),
        used: nextLines.reduce((sum, line) => sum + qty(line.usedQuantity), 0),
        wasted: nextLines.reduce((sum, line) => sum + qty(line.wastedQuantity), 0),
        returned: nextLines.reduce((sum, line) => sum + qty(line.returnedQuantity), 0)
      };
      if (requestedStatus === 'Reconciled') { usage.reconciledAt = new Date(); usage.reconciledBy = user._id; }
      usage.version = Number(usage.version || 0) + 1;
      await usage.save({ session });
    });

    if (usage.status === 'Reconciled') await postBillingForReconciledUsage({ otCase, usage, user });
    return usage;
  } finally {
    if (session) await session.endSession();
  }
}

module.exports = { saveInventoryUsage, postBillingForReconciledUsage };
