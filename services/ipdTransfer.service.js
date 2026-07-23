const crypto = require('crypto');
const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const IPDBedTransfer = require('../models/IPDBedTransfer');
const IPDAccommodationSegment = require('../models/IPDAccommodationSegment');
const Bed = require('../models/Bed');
const Room = require('../models/Room');
const Ward = require('../models/Ward');
const { appendDomainEvent } = require('./auditEvent.service');
const { quotePricing } = require('./pricingEngine.service');

function error(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function id(value) {
  return value?._id || value;
}

function correlationId() {
  return `tr_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
}

async function nextTransferNumber(hospitalId, session) {
  const count = await IPDBedTransfer.countDocuments({ hospitalId }).session(session);
  const dateStr = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `TRF-${dateStr}-${String(count + 1).padStart(5, '0')}`;
}

async function loadLocation(hospitalId, bedId, session) {
  const bed = await Bed.findOne({ _id: bedId, hospitalId, isActive: true }).session(session);

  if (!bed) {
    throw error('Destination bed not found', 404);
  }

  const [room, ward] = await Promise.all([
    Room.findOne({ _id: bed.roomId, hospitalId }).session(session),
    bed.wardId ? Ward.findOne({ _id: bed.wardId, hospitalId }).session(session) : null
  ]);

  if (!room) {
    throw error('Destination room not found', 404);
  }

  return { bed, room, ward };
}

async function createTransfer({ req, hospitalId, admissionId, payload, session }) {
  const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).session(session || null);

  if (!admission) {
    throw error('Admission not found', 404);
  }

  if (['Discharged', 'Cancelled', 'Expired'].includes(admission.status)) {
    throw error('Cannot transfer an inactive admission', 409);
  }

  if (!payload.toBedId) {
    throw error('Destination bed is required');
  }

  if (String(admission.bedId) === String(payload.toBedId)) {
    throw error('Destination bed must be different from the current bed');
  }

  const destination = await loadLocation(hospitalId, payload.toBedId, session);

  const duplicate = payload.idempotencyKey
    ? await IPDBedTransfer.findOne({ hospitalId, idempotencyKey: payload.idempotencyKey }).session(session || null)
    : null;

  if (duplicate) {
    return duplicate;
  }

  const [transfer] = await IPDBedTransfer.create([{
    hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    transferNumber: await nextTransferNumber(hospitalId, session),
    source: payload.source || 'manual',
    idempotencyKey: payload.idempotencyKey,
    from: {
      wardId: admission.wardId,
      roomId: admission.roomId,
      bedId: admission.bedId,
      effectiveAt: admission.currentLocationEffectiveAt || admission.admissionDate
    },
    to: {
      wardId: destination.ward?._id || destination.bed.wardId,
      roomId: destination.room._id,
      bedId: destination.bed._id
    },
    requestedEffectiveAt: payload.requestedEffectiveAt,
    clinical: {
      reason: payload.reason || 'Clinical transfer',
      diagnosisContext: payload.diagnosisContext,
      priority: payload.priority || 'routine',
      patientCondition: payload.patientCondition,
      isolationRequired: Boolean(payload.isolationRequired),
      oxygenRequired: Boolean(payload.oxygenRequired),
      equipmentNeeds: payload.equipmentNeeds || [],
      genderPolicy: payload.genderPolicy
    },
    handover: payload.handover || {},
    people: { requestedBy: req.user?._id },
    timeline: [{ status: 'Requested', at: new Date(), by: req.user?._id, note: payload.note }],
    correlationId: correlationId()
  }], { session });

  await appendDomainEvent({
    req,
    eventType: 'ipd.transfer.requested',
    entityType: 'IPDBedTransfer',
    entityId: transfer._id,
    hospitalId,
    patientId: admission.patientId,
    encounterId: admission._id,
    correlationId: transfer.correlationId,
    afterSummary: {
      transferNumber: transfer.transferNumber,
      toBedId: transfer.to.bedId,
      priority: transfer.clinical.priority
    },
    session
  });

  return transfer;
}

async function reserveTransfer({ req, hospitalId, transferId, expiresInMinutes = 30, session }) {
  const transfer = await IPDBedTransfer.findOne({ _id: transferId, hospitalId }).session(session || null);

  if (!transfer) {
    throw error('Transfer not found', 404);
  }

  if (!['Requested', 'Reserved'].includes(transfer.status)) {
    throw error(`Cannot reserve a transfer in ${transfer.status} status`, 409);
  }

  if (transfer.status === 'Reserved') {
    return transfer;
  }

  const reservation = await Bed.findOneAndUpdate(
    {
      _id: transfer.to.bedId,
      hospitalId,
      isActive: true,
      status: 'Available',
      $or: [
        { reservedTransferId: null },
        { reservedTransferId: { $exists: false } }
      ]
    },
    {
      $set: {
        status: 'Reserved',
        reservedTransferId: transfer._id,
        reservationExpiresAt: new Date(Date.now() + expiresInMinutes * 60000)
      }
    },
    { new: true, session }
  );

  if (!reservation) {
    throw error('Destination bed is no longer available', 409);
  }

  transfer.status = 'Reserved';
  transfer.people.reservedBy = req.user?._id;
  transfer.reservation = {
    reservedAt: new Date(),
    expiresAt: reservation.reservationExpiresAt
  };
  transfer.timeline.push({ status: 'Reserved', at: new Date(), by: req.user?._id });
  transfer.revision += 1;
  await transfer.save({ session });

  await appendDomainEvent({
    req,
    eventType: 'ipd.transfer.bed_reserved',
    entityType: 'IPDBedTransfer',
    entityId: transfer._id,
    hospitalId,
    patientId: transfer.patientId,
    encounterId: transfer.admissionId,
    revision: transfer.revision,
    correlationId: transfer.correlationId,
    afterSummary: {
      bedId: transfer.to.bedId,
      expiresAt: transfer.reservation.expiresAt
    },
    session
  });

  return transfer;
}

async function approveTransfer({ req, hospitalId, transferId, note, session }) {
  const transfer = await IPDBedTransfer.findOne({ _id: transferId, hospitalId }).session(session || null);

  if (!transfer) {
    throw error('Transfer not found', 404);
  }

  if (transfer.status !== 'Reserved') {
    throw error('Transfer must have a reserved destination before approval', 409);
  }

  transfer.status = 'Approved';
  transfer.people.approvedBy = req.user?._id;
  transfer.timeline.push({ status: 'Approved', at: new Date(), by: req.user?._id, note });
  transfer.revision += 1;
  await transfer.save({ session });

  await appendDomainEvent({
    req,
    eventType: 'ipd.transfer.approved',
    entityType: 'IPDBedTransfer',
    entityId: transfer._id,
    hospitalId,
    patientId: transfer.patientId,
    encounterId: transfer.admissionId,
    revision: transfer.revision,
    correlationId: transfer.correlationId,
    afterSummary: { status: transfer.status },
    session
  });

  return transfer;
}

async function startTransfer({ req, hospitalId, transferId, handover, session }) {
  const transfer = await IPDBedTransfer.findOne({ _id: transferId, hospitalId }).session(session || null);

  if (!transfer) {
    throw error('Transfer not found', 404);
  }

  if (transfer.status !== 'Approved') {
    throw error('Transfer must be approved before movement starts', 409);
  }

  transfer.status = 'In Transfer';
  transfer.people.releasedBy = req.user?._id;
  transfer.handover = {
    ...(transfer.handover?.toObject?.() || transfer.handover || {}),
    ...handover,
    sourceNurseAcknowledgedAt: new Date()
  };
  transfer.timeline.push({
    status: 'In Transfer',
    at: new Date(),
    by: req.user?._id,
    note: handover?.note
  });
  transfer.revision += 1;
  await transfer.save({ session });

  return transfer;
}

async function completeTransfer({ req, hospitalId, transferId, payload = {}, session }) {
  const transfer = await IPDBedTransfer.findOne({ _id: transferId, hospitalId }).session(session);

  if (!transfer) {
    throw error('Transfer not found', 404);
  }

  if (!['Approved', 'In Transfer'].includes(transfer.status)) {
    throw error('Transfer is not ready for completion', 409);
  }

  const admission = await IPDAdmission.findOne({ _id: transfer.admissionId, hospitalId }).session(session);

  if (!admission) {
    throw error('Admission not found', 404);
  }

  if (String(admission.bedId) !== String(transfer.from.bedId)) {
    throw error('Admission location changed after this transfer was requested', 409);
  }

  const destination = await Bed.findOne({
    _id: transfer.to.bedId,
    hospitalId,
    status: 'Reserved',
    reservedTransferId: transfer._id,
    reservationExpiresAt: { $gt: new Date() }
  }).session(session);

  if (!destination) {
    throw error('Reserved destination bed is unavailable or reservation expired', 409);
  }

  const source = transfer.from.bedId
    ? await Bed.findOne({
      _id: transfer.from.bedId,
      hospitalId,
      currentAdmissionId: admission._id
    }).session(session)
    : null;

  const actual = payload.actualEffectiveAt ? new Date(payload.actualEffectiveAt) : new Date();

  const oldSegment = await IPDAccommodationSegment.findOne({
    hospitalId,
    admissionId: admission._id,
    status: 'active'
  }).session(session);

  if (oldSegment) {
    oldSegment.endedAt = actual;
    oldSegment.status = 'closed';
    await oldSegment.save({ session });
  }

  let pricingSnapshot;

  try {
    pricingSnapshot = await quotePricing({
      hospitalId,
      admissionId: admission._id,
      serviceDate: actual,
      chargeType: 'Bed',
      serviceType: 'bed',
      externalCode: destination.bedCode,
      internalServiceModel: 'Bed',
      internalServiceId: destination._id,
      standardAmount: destination.dailyCharge,
      quantity: 1
    });
  } catch (pricingError) {
    pricingSnapshot = {
      inputs: { serviceDate: actual, fallbackReason: pricingError.message },
      amounts: {
        hospitalStandard: Number(destination.dailyCharge || 0),
        contracted: Number(destination.dailyCharge || 0),
        patientLiability: Number(destination.dailyCharge || 0),
        sponsorLiability: 0,
        nonAdmissible: 0,
        hospitalAdjustment: 0
      },
      explanation: ['Standard bed rate used because no approved payer mapping was available']
    };
  }

  const [newSegment] = await IPDAccommodationSegment.create([{
    hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    wardId: transfer.to.wardId,
    roomId: transfer.to.roomId,
    bedId: transfer.to.bedId,
    bedType: destination.bedType,
    startedAt: actual,
    sourceTransferId: transfer._id,
    pricingSnapshot,
    dailyRate: pricingSnapshot.amounts?.contracted ?? destination.dailyCharge,
    createdBy: req.user?._id
  }], { session });

  if (source) {
    source.status = 'Cleaning';
    source.currentAdmissionId = null;
    source.reservedTransferId = null;
    source.reservationExpiresAt = null;
    source.cleaningStartedAt = actual;
    await source.save({ session });
  }

  destination.status = 'Occupied';
  destination.currentAdmissionId = admission._id;
  destination.reservedTransferId = null;
  destination.reservationExpiresAt = null;
  await destination.save({ session });

  admission.wardId = transfer.to.wardId;
  admission.roomId = transfer.to.roomId;
  admission.bedId = transfer.to.bedId;
  admission.currentLocationEffectiveAt = actual;
  await admission.save({ session });

  transfer.status = 'Completed';
  transfer.actualEffectiveAt = actual;
  transfer.people.receivedBy = req.user?._id;
  transfer.people.completedBy = req.user?._id;
  transfer.handover.receivingNurseAcknowledgedAt = actual;
  transfer.handover.conditionOnArrival = payload.conditionOnArrival;
  transfer.timeline.push({
    status: 'Completed',
    at: actual,
    by: req.user?._id,
    note: payload.note
  });

  transfer.billing = {
    oldSegmentId: oldSegment?._id,
    newSegmentId: newSegment._id,
    oldSegmentEndedAt: oldSegment ? actual : undefined,
    newSegmentStartedAt: actual,
    chargeGenerationStatus: 'completed'
  };

  transfer.revision += 1;
  await transfer.save({ session });

  await appendDomainEvent({
    req,
    eventType: 'ipd.transfer.completed',
    entityType: 'IPDBedTransfer',
    entityId: transfer._id,
    hospitalId,
    patientId: admission.patientId,
    encounterId: admission._id,
    revision: transfer.revision,
    correlationId: transfer.correlationId,
    afterSummary: {
      fromBedId: transfer.from.bedId,
      toBedId: transfer.to.bedId,
      actualEffectiveAt: actual,
      oldSegmentId: oldSegment?._id,
      newSegmentId: newSegment._id
    },
    session
  });

  return transfer;
}

async function cancelTransfer({ req, hospitalId, transferId, reason, session }) {
  const transfer = await IPDBedTransfer.findOne({ _id: transferId, hospitalId }).session(session || null);

  if (!transfer) {
    throw error('Transfer not found', 404);
  }

  if (transfer.status === 'Completed') {
    throw error('Completed transfers cannot be cancelled; create a corrective transfer', 409);
  }

  if (['Cancelled', 'Rejected'].includes(transfer.status)) {
    return transfer;
  }

  await Bed.updateOne(
    {
      _id: transfer.to.bedId,
      hospitalId,
      reservedTransferId: transfer._id
    },
    {
      $set: {
        status: 'Available',
        reservedTransferId: null,
        reservationExpiresAt: null
      }
    },
    { session }
  );

  transfer.status = 'Cancelled';
  transfer.cancellation = {
    reason,
    cancelledAt: new Date(),
    cancelledBy: req.user?._id
  };
  transfer.timeline.push({
    status: 'Cancelled',
    at: new Date(),
    by: req.user?._id,
    note: reason
  });
  transfer.revision += 1;
  await transfer.save({ session });

  await appendDomainEvent({
    req,
    eventType: 'ipd.transfer.cancelled',
    entityType: 'IPDBedTransfer',
    entityId: transfer._id,
    hospitalId,
    patientId: transfer.patientId,
    encounterId: transfer.admissionId,
    revision: transfer.revision,
    correlationId: transfer.correlationId,
    afterSummary: { reason },
    session
  });

  return transfer;
}

async function releaseBedAfterCleaning({ req, hospitalId, bedId, note, session }) {
  const bed = await Bed.findOne({
    _id: bedId,
    hospitalId,
    status: 'Cleaning',
    currentAdmissionId: null
  }).session(session || null);

  if (!bed) {
    throw error('Bed is not awaiting cleaning', 409);
  }

  bed.status = 'Available';
  bed.cleaningCompletedAt = new Date();
  bed.cleaningNote = note;
  await bed.save({ session });

  return bed;
}

async function transaction(work) {
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

module.exports = {
  transaction,
  createTransfer,
  reserveTransfer,
  approveTransfer,
  startTransfer,
  completeTransfer,
  cancelTransfer,
  releaseBedAfterCleaning
};