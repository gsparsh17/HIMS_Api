const ClaimCase = require('../models/ClaimCase');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

async function nextClaimNumber(hospitalId) {
  const count = await ClaimCase.countDocuments({ hospitalId });
  const dateStr = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `CLM-${dateStr}-${String(count + 1).padStart(5, '0')}`;
}

async function nextEntryNumber(hospitalId) {
  const count = await SponsorLedgerEntry.countDocuments({ hospitalId });
  return `SLE-${new Date().getFullYear()}-${String(count + 1).padStart(7, '0')}`;
}

async function recalcAdmission(admissionId, hospitalId) {
  const mongoose = require('mongoose');

  const rows = await IPDCharge.aggregate([
    {
      $match: {
        admissionId: mongoose.Types.ObjectId.createFromHexString(String(admissionId)),
        hospitalId: mongoose.Types.ObjectId.createFromHexString(String(hospitalId)),
        status: { $in: ['ACTIVE', 'INVOICED'] }
      }
    },
    {
      $group: {
        _id: null,
        patient: { $sum: '$patientLiability' },
        sponsor: { $sum: '$sponsorLiability' },
        nonAdmissible: { $sum: '$nonAdmissibleAmount' },
        contracted: { $sum: '$netAmount' }
      }
    }
  ]);

  const totals = rows[0] || {
    patient: 0,
    sponsor: 0,
    nonAdmissible: 0,
    contracted: 0
  };

  await IPDAdmission.updateOne(
    { _id: admissionId, hospitalId },
    {
      $set: {
        patientReceivable: totals.patient,
        sponsorReceivable: totals.sponsor,
        nonAdmissibleAmount: totals.nonAdmissible,
        totalBillAmount: totals.contracted,
        dueAmount: totals.patient
      }
    }
  );

  return totals;
}

exports.create = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const admission = await IPDAdmission.findOne({
      _id: req.body.admissionId,
      hospitalId
    });

    if (!admission) {
      return res.status(404).json({
        success: false,
        error: 'Admission not found'
      });
    }

    const coverage = await AdmissionCoverage.findOne({
      _id: req.body.coverageId || admission.coverageId,
      hospitalId,
      admissionId: admission._id,
      active: true
    });

    if (!coverage) {
      return res.status(409).json({
        success: false,
        error: 'Active sponsored coverage is required'
      });
    }

    const totals = await recalcAdmission(admission._id, hospitalId);

    const data = await ClaimCase.create({
      hospitalId,
      claimNumber: await nextClaimNumber(hospitalId),
      admissionId: admission._id,
      patientId: admission.patientId,
      coverageId: coverage._id,
      payerId: coverage.payerId,
      type: req.body.type || 'cashless',
      status: req.body.status || 'draft',
      preAuth: {
        requestNumber: coverage.preAuthorisation?.requestNumber,
        approvedAmount: coverage.preAuthorisation?.approvedAmount,
        status: coverage.preAuthorisation?.status
      },
      amounts: {
        contractedAmount: totals.contracted,
        sponsorLiability: totals.sponsor,
        patientLiability: totals.patient,
        nonAdmissibleAmount: totals.nonAdmissible,
        outstandingSponsorAmount: totals.sponsor
      },
      documents: req.body.documents || [],
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    res.status(201).json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.list = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.status) {
      filter.status = req.query.status;
    }

    if (req.query.payerId) {
      filter.payerId = req.query.payerId;
    }

    const data = await ClaimCase
      .find(filter)
      .populate('payerId', 'code name type')
      .populate({
        path: 'admissionId',
        select: 'admissionNumber patientId dischargeDate',
        populate: {
          path: 'patientId',
          select: 'first_name last_name patientId uhid'
        }
      })
      .sort({ createdAt: -1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.get = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await ClaimCase
      .findOne({ _id: req.params.id, hospitalId })
      .populate('payerId coverageId admissionId patientId');

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Claim not found'
      });
    }

    const ledger = await SponsorLedgerEntry
      .find({ hospitalId, claimId: data._id })
      .sort({ occurredAt: 1 });

    res.json({ success: true, data, ledger });
  } catch (e) {
    fail(res, e);
  }
};

exports.submit = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const claim = await ClaimCase.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!claim) {
      return res.status(404).json({
        success: false,
        error: 'Claim not found'
      });
    }

    if (!['draft', 'documents_pending', 'ready', 'query'].includes(claim.status)) {
      return res.status(409).json({
        success: false,
        error: 'Claim cannot be submitted in its current status'
      });
    }

    claim.status = 'submitted';
    claim.submittedAt = new Date();
    claim.submittedBy = req.user._id;
    claim.amounts.claimSubmittedAmount = Number(req.body.amount || claim.amounts.sponsorLiability);
    claim.amounts.outstandingSponsorAmount = claim.amounts.claimSubmittedAmount;
    claim.updatedBy = req.user._id;
    claim.revision += 1;
    await claim.save();

    await SponsorLedgerEntry.create({
      hospitalId,
      payerId: claim.payerId,
      admissionId: claim.admissionId,
      patientId: claim.patientId,
      claimId: claim._id,
      entryNumber: await nextEntryNumber(hospitalId),
      entryType: 'receivable',
      debit: claim.amounts.claimSubmittedAmount,
      credit: 0,
      balanceAfter: claim.amounts.claimSubmittedAmount,
      reference: claim.claimNumber,
      reason: 'Claim submitted',
      createdBy: req.user._id
    });

    await IPDAdmission.updateOne(
      { _id: claim.admissionId, hospitalId },
      { $set: { claimSubmittedAmount: claim.amounts.claimSubmittedAmount } }
    );

    await appendDomainEvent({
      req,
      eventType: 'billing.claim_submitted',
      entityType: 'ClaimCase',
      entityId: claim._id,
      hospitalId,
      patientId: claim.patientId,
      encounterId: claim.admissionId,
      revision: claim.revision,
      afterSummary: {
        claimNumber: claim.claimNumber,
        amount: claim.amounts.claimSubmittedAmount
      }
    });

    res.json({ success: true, data: claim });
  } catch (e) {
    fail(res, e);
  }
};

exports.queryResponse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const claim = await ClaimCase.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!claim) {
      return res.status(404).json({
        success: false,
        error: 'Claim not found'
      });
    }

    claim.queries = claim.queries || [];

    if (req.body.queryNumber && req.body.response) {
      const q = claim.queries.find((x) => x.queryNumber === req.body.queryNumber);

      if (q) {
        q.response = req.body.response;
        q.respondedAt = new Date();
        q.respondedBy = req.user._id;
        q.status = 'responded';
      } else {
        claim.queries.push({
          queryNumber: req.body.queryNumber,
          text: req.body.text,
          receivedAt: req.body.receivedAt || new Date(),
          dueAt: req.body.dueAt,
          response: req.body.response,
          respondedAt: new Date(),
          respondedBy: req.user._id,
          status: 'responded'
        });
      }
    } else {
      claim.queries.push({
        queryNumber: req.body.queryNumber || `Q-${Date.now()}`,
        text: req.body.text,
        receivedAt: new Date(),
        dueAt: req.body.dueAt,
        status: 'open'
      });
    }

    claim.status = 'query';
    claim.revision += 1;
    claim.updatedBy = req.user._id;
    await claim.save();

    res.json({ success: true, data: claim });
  } catch (e) {
    fail(res, e);
  }
};

exports.settlement = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const claim = await ClaimCase.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!claim) {
      return res.status(404).json({
        success: false,
        error: 'Claim not found'
      });
    }

    const amount = Number(req.body.amount || 0);

    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Settlement amount must be greater than zero'
      });
    }

    const previousPaid = Number(claim.amounts.sponsorPaidAmount || 0);

    claim.settlements.push({
      amount,
      receivedAt: req.body.receivedAt || new Date(),
      reference: req.body.reference,
      method: req.body.method,
      recordedBy: req.user._id
    });

    claim.amounts.approvedSponsorAmount = Number(
      req.body.approvedSponsorAmount ??
      claim.amounts.approvedSponsorAmount ??
      claim.amounts.claimSubmittedAmount
    );

    claim.amounts.deductedAmount = Number(
      req.body.deductedAmount ??
      claim.amounts.deductedAmount ??
      0
    );

    claim.amounts.sponsorPaidAmount = previousPaid + amount;
    claim.amounts.outstandingSponsorAmount = Math.max(
      0,
      claim.amounts.approvedSponsorAmount - claim.amounts.sponsorPaidAmount
    );

    claim.status = claim.amounts.outstandingSponsorAmount === 0
      ? 'settled'
      : 'partially_settled';

    claim.revision += 1;
    claim.updatedBy = req.user._id;
    await claim.save();

    const previousLedger = await SponsorLedgerEntry
      .findOne({ hospitalId, payerId: claim.payerId })
      .sort({ occurredAt: -1 });

    const balanceAfter = Math.max(
      0,
      Number(previousLedger?.balanceAfter || claim.amounts.claimSubmittedAmount) - amount
    );

    await SponsorLedgerEntry.create({
      hospitalId,
      payerId: claim.payerId,
      admissionId: claim.admissionId,
      patientId: claim.patientId,
      claimId: claim._id,
      entryNumber: await nextEntryNumber(hospitalId),
      entryType: 'settlement',
      debit: 0,
      credit: amount,
      balanceAfter,
      reference: req.body.reference,
      reason: req.body.note || 'Sponsor settlement',
      createdBy: req.user._id
    });

    await IPDAdmission.updateOne(
      { _id: claim.admissionId, hospitalId },
      {
        $set: {
          approvedSponsorAmount: claim.amounts.approvedSponsorAmount,
          sponsorPaidAmount: claim.amounts.sponsorPaidAmount,
          sponsorReceivable: claim.amounts.outstandingSponsorAmount
        }
      }
    );

    await appendDomainEvent({
      req,
      eventType: claim.status === 'settled'
        ? 'billing.claim_settled'
        : 'billing.claim_partially_settled',
      entityType: 'ClaimCase',
      entityId: claim._id,
      hospitalId,
      patientId: claim.patientId,
      encounterId: claim.admissionId,
      revision: claim.revision,
      afterSummary: {
        amount,
        paid: claim.amounts.sponsorPaidAmount,
        outstanding: claim.amounts.outstandingSponsorAmount
      }
    });

    res.json({ success: true, data: claim });
  } catch (e) {
    fail(res, e);
  }
};

exports.ledger = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    if (req.query.payerId) {
      filter.payerId = req.query.payerId;
    }

    if (req.query.admissionId) {
      filter.admissionId = req.query.admissionId;
    }

    const data = await SponsorLedgerEntry
      .find(filter)
      .populate('payerId', 'code name')
      .populate('admissionId', 'admissionNumber')
      .sort({ occurredAt: -1 });

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};