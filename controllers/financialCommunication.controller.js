'use strict';

const mongoose = require('mongoose');
const Payer = require('../models/Payer');
const ClaimCase = require('../models/ClaimCase');
const DomainEvent = require('../models/DomainEvent');
const Patient = require('../models/Patient');
const { queueNotification } = require('../services/nabhNotification.service');
const { hospitalId, required, ref, sendError } = require('../utils/functionalDomain');
const claimService = require('../services/claim.service');

function validId(value) {
  return mongoose.isValidObjectId(value);
}

exports.payerNotice = async (req, res) => {
  try {
    required(req.body, ['payerId', 'noticeType', 'message']);

    if (!validId(req.body.payerId)) {
      return res.status(400).json({
        error: 'Valid payerId is required'
      });
    }

    const payer = await Payer.findOne({
      _id: req.body.payerId,
      hospitalId: hospitalId(req)
    });

    if (!payer) {
      return res.status(404).json({
        error: 'Payer not found'
      });
    }

    const event = await DomainEvent.create({
      eventId: ref('EVT'),
      eventType: 'payer_notice_received',
      hospitalId: hospitalId(req),
      actorUserId: req.user._id,
      actorRole: req.user.role,
      entityType: 'Payer',
      entityId: payer._id,
      correlationId: req.body.referenceNumber || ref('PNO'),
      afterSummary: {
        noticeType: req.body.noticeType,
        message: req.body.message,
        effectiveFrom: req.body.effectiveFrom,
        effectiveTo: req.body.effectiveTo
      },
      metadata: {
        source: req.body.source || 'payer_portal'
      }
    });

    return res.status(201).json({
      success: true,
      data: event
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.payerNotices = async (req, res) => {
  try {
    const f = {
      hospitalId: hospitalId(req),
      eventType: 'payer_notice_received'
    };

    if (req.query.payerId) {
      if (!validId(req.query.payerId)) {
        return res.status(400).json({
          error: 'Invalid payerId'
        });
      }
      f.entityId = req.query.payerId;
    }

    if (req.query.referenceNumber) {
      f.correlationId = req.query.referenceNumber;
    }

    const data = await DomainEvent
      .find(f)
      .sort({ occurredAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.notifyClaim = async (req, res) => {
  try {
    required(req.body, ['claimId']);

    if (!validId(req.body.claimId)) {
      return res.status(400).json({
        error: 'Valid claimId is required'
      });
    }

    const claim = await ClaimCase
      .findOne({
        _id: req.body.claimId,
        hospitalId: hospitalId(req)
      })
      .lean();

    if (!claim) {
      return res.status(404).json({
        error: 'Claim not found'
      });
    }

    const patientId = claim.patientId || claim.patient_id;
    const patient = patientId
      ? await Patient.findById(patientId).select('phone email')
      : null;

    const delivery = await queueNotification({
      hospitalId: hospitalId(req),
      eventType: 'claim_status',
      correlationId: claim.claimNumber || String(claim._id),
      recipientType: 'patient',
      requestedChannels: req.body.channels || ['portal'],
      contact: {
        phone: patient?.phone,
        email: patient?.email
      },
      priority: 'normal',
      subject: req.body.subject || `Claim ${claim.claimNumber || claim._id} update`,
      body: req.body.message || `Claim status: ${claim.status}`,
      patientId,
      payload: {
        claimId: claim._id,
        claimNumber: claim.claimNumber,
        status: claim.status,
        submittedAt: claim.submittedAt || claim.createdAt
      },
      createdBy: req.user._id
    });

    await DomainEvent.create({
      eventId: ref('EVT'),
      eventType: 'claim_notification_sent',
      hospitalId: hospitalId(req),
      patientId,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      entityType: 'ClaimCase',
      entityId: claim._id,
      correlationId: String(delivery._id),
      metadata: {
        notificationDeliveryId: delivery._id,
        status: delivery.status
      }
    });

    return res.status(201).json({
      success: true,
      data: delivery
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.claimNotificationHistory = async (req, res) => {
  try {
    if (!validId(req.params.claimId)) {
      return res.status(400).json({
        error: 'Invalid claimId'
      });
    }

    const data = await DomainEvent
      .find({
        hospitalId: hospitalId(req),
        eventType: 'claim_notification_sent',
        entityId: req.params.claimId
      })
      .sort({ occurredAt: -1 })
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.payerReconciliation = async (req, res) => {
  try {
    required(req.body, ['claimId', 'amount', 'reference']);

    if (!validId(req.body.claimId)) {
      return res.status(400).json({
        error: 'Valid claimId is required'
      });
    }

    const claim = await claimService.recordSettlement({
      hospitalId: hospitalId(req),
      claimId: req.body.claimId,
      body: {
        amount: req.body.amount,
        reference: req.body.reference,
        note: req.body.note || 'Payer reconciliation notice',
        receivedAt: req.body.receivedAt,
        idempotencyKey: req.body.idempotencyKey || `reconciliation:${req.body.reference}`
      },
      user: req.user
    });

    const event = await DomainEvent.create({
      eventId: ref('EVT'),
      eventType: 'payer_reconciliation_processed',
      hospitalId: hospitalId(req),
      patientId: claim.patientId,
      actorUserId: req.user._id,
      actorRole: req.user.role,
      entityType: 'ClaimCase',
      entityId: claim._id,
      correlationId: req.body.reference,
      afterSummary: {
        status: claim.status,
        sponsorPaidAmount: claim.amounts?.sponsorPaidAmount,
        outstandingSponsorAmount: claim.amounts?.outstandingSponsorAmount
      },
      metadata: {
        privacy: 'tenant_scoped',
        source: req.body.source || 'payer'
      }
    });

    return res.json({
      success: true,
      data: claim,
      eventId: event.eventId
    });
  } catch (e) {
    return sendError(res, e);
  }
};