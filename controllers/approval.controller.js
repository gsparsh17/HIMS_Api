const ApprovalRequest = require('../models/ApprovalRequest');
const IPDAdmission = require('../models/IPDAdmission');
const IPDCharge = require('../models/IPDCharge');
const patientFinancial = require('../services/patientFinancial.service');
const ipdFinancial = require('../services/ipdFinancial.service');
const { requestHospitalId } = require('../utils/hospitalScope');

const APPROVAL_STATUSES = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected'
};

const REQUEST_TYPES = new Set(['DISCOUNT_APPROVAL', 'OTHER']);

function normalizeApprovalStatus(value) {
  return APPROVAL_STATUSES[String(value || '').trim().toLowerCase()] || null;
}

function normalizeRequestType(value) {
  const normalized = String(value || 'DISCOUNT_APPROVAL')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
  return REQUEST_TYPES.has(normalized) ? normalized : null;
}

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.statusCode ? error.message : 'Internal server error'
  });
}

exports.createRequest = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const { patientId, admissionId, details } = req.body;
    const requestType = normalizeRequestType(req.body.requestType);
    if (!requestType) {
      return res.status(400).json({ success: false, error: 'Invalid request type.' });
    }

    if (admissionId) {
      const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).select('_id');
      if (!admission) {
        return res.status(404).json({ success: false, error: 'Admission not found for this hospital.' });
      }
    }

    if (admissionId) {
      const existing = await ApprovalRequest.findOne({
        hospitalId,
        requestType,
        admissionId,
        status: 'Pending'
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'A pending approval request already exists for this admission.'
        });
      }
    }

    const request = await ApprovalRequest.create({
      hospitalId,
      requestType,
      patientId,
      admissionId,
      details,
      requestedBy: req.user._id,
      status: 'Pending'
    });

    return res.status(201).json({ success: true, request });
  } catch (error) {
    console.error('Error creating approval request:', error.message);
    return sendError(res, error);
  }
};

exports.getRequests = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const { admissionId } = req.query;
    const query = { hospitalId };

    if (req.query.status) {
      const status = normalizeApprovalStatus(req.query.status);
      if (!status) return res.status(400).json({ success: false, error: 'Invalid status.' });
      query.status = status;
    }

    if (req.query.requestType) {
      const requestType = normalizeRequestType(req.query.requestType);
      if (!requestType) {
        return res.status(400).json({ success: false, error: 'Invalid request type.' });
      }
      query.requestType = requestType;
    }

    if (admissionId) query.admissionId = admissionId;

    const requests = await ApprovalRequest.find(query)
      .populate('requestedBy', 'name email first_name last_name')
      .populate('approvedBy', 'name email first_name last_name')
      .populate({ path: 'patientId', select: 'first_name last_name patientId uhid phone' })
      .populate({ path: 'admissionId', select: 'admissionNumber' })
      .populate({ path: 'appointmentId', select: 'appointment_date type' })
      .populate({ path: 'billId', select: 'bill_number total_amount discount status' })
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, requests });
  } catch (error) {
    console.error('Error fetching approval requests:', error.message);
    return sendError(res, error);
  }
};

exports.updateRequestStatus = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const status = normalizeApprovalStatus(req.body.status);
    if (!status || status === 'Pending') {
      return res.status(400).json({ success: false, error: 'Status must be Approved or Rejected.' });
    }

    const request = await ApprovalRequest.findOne({
      _id: req.params.id,
      hospitalId
    });

    if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
    if (request.status !== 'Pending') {
      return res.status(409).json({ success: false, error: 'Request is already processed.' });
    }

    request.status = status;
    request.approvedBy = req.user._id;
    request.approvedAt = new Date();
    if (status === 'Rejected' && req.body.rejectionReason) {
      request.rejectionReason = req.body.rejectionReason;
    }

    await request.save();

    // Synchronize decision onto the associated Bill if this is a discount approval
    if (request.requestType === 'DISCOUNT_APPROVAL') {
      try {
        const Bill = require('../models/Bill');
        const billId = request.billId || request.details?.billId;
        if (billId) {
          const bill = await Bill.findOne({ _id: billId, hospital_id: hospitalId });
          if (bill) {
            if (status === 'Approved') {
              bill.discount_approval = {
                ...(bill.discount_approval?.toObject?.() || bill.discount_approval || {}),
                status: 'APPROVED',
                approved_by: req.user._id,
                approved_at: new Date(),
                approval_notes: String(req.body.approvalNotes || '').trim()
              };
              const paid = Number(bill.paid_amount || 0);
              const total = Number(bill.total_amount || 0);
              if (paid >= total && total > 0) {
                bill.status = 'Paid';
              } else if (paid > 0) {
                bill.status = 'Partially Paid';
              } else {
                bill.status = 'Pending';
              }
            } else if (status === 'Rejected') {
              bill.discount_approval = {
                ...(bill.discount_approval?.toObject?.() || bill.discount_approval || {}),
                status: 'REJECTED',
                approved_by: req.user._id,
                approved_at: new Date(),
                rejection_reason: String(req.body.rejectionReason || 'Discount rejected').trim()
              };
              patientFinancial.rejectOPDBillDiscount(bill);
              bill.balance_due = Math.max(0, Number(bill.total_amount || 0) - Number(bill.paid_amount || 0));
              bill.status = Number(bill.paid_amount || 0) >= bill.total_amount ? 'Paid' : (Number(bill.paid_amount || 0) > 0 ? 'Partially Paid' : 'Pending');
            }
            await bill.save();

            if (bill.invoice_id) {
              try {
                const invoiceId = bill.invoice_id?._id || bill.invoice_id;
                await patientFinancial.syncOPDInvoiceFromBills(invoiceId, hospitalId);
              } catch (invErr) {
                console.warn('Could not sync consolidated invoice on discount approval:', invErr.message);
              }
            }
          }
        }
      } catch (syncErr) {
        console.warn('Could not sync approval decision to bill:', syncErr.message);
      }

      // IPD charge discounts use the same ApprovalRequest collection but are
      // attached to an IPDCharge instead of a Bill. Approval makes the already
      // priced discount collectible/invoiceable; rejection restores the charge
      // to its undiscounted amount before any invoice can be issued.
      const chargeId = request.details?.chargeId;
      if (chargeId) {
        try {
          const charge = await IPDCharge.findOne({ _id: chargeId, hospitalId });
          if (charge && !charge.isBilled && charge.status === 'ACTIVE') {
            if (status === 'Approved') {
              charge.discountApprovedBy = req.user._id;
              charge.discountApprovedAt = new Date();
              charge.discountDetails = {
                ...(charge.discountDetails?.toObject?.() || charge.discountDetails || {}),
                approvedBy: req.user._id,
                approvedAt: new Date()
              };
              charge.financialPolicySnapshot = {
                ...(charge.financialPolicySnapshot || {}),
                discountApproval: { status: 'APPROVED', approvedBy: req.user._id, approvedAt: new Date() }
              };
            } else {
              const rejectedDiscount = Number(charge.discountAmount || charge.discount || 0);
              const previousNet = Number(charge.netAmount || 0);
              const gross = Number(charge.quantity || 0) * Number(charge.rate || 0);
              const taxRate = Number(charge.taxRate || 0);
              const taxMode = charge.taxMode || 'exclusive';
              const restoredNet = taxMode === 'exclusive'
                ? gross + (gross * taxRate / 100)
                : gross;
              const liabilityDelta = Number((restoredNet - previousNet).toFixed(2));

              charge.discountAmount = 0;
              charge.discount = 0;
              charge.discountRate = 0;
              charge.discountReason = undefined;
              charge.discountApprovedBy = undefined;
              charge.discountApprovedAt = undefined;
              charge.discountDetails = { type: charge.discountType || 'fixed', rate: 0, amount: 0 };
              if (charge.pricingSnapshot?.amounts) {
                charge.pricingSnapshot.amounts.patientLiability = Number((Number(charge.pricingSnapshot.amounts.patientLiability || 0) + liabilityDelta).toFixed(2));
                charge.pricingSnapshot.amounts.hospitalConcession = Math.max(0, Number((Number(charge.pricingSnapshot.amounts.hospitalConcession || 0) - rejectedDiscount).toFixed(2)));
                charge.markModified('pricingSnapshot');
              }
              charge.financialPolicySnapshot = {
                ...(charge.financialPolicySnapshot || {}),
                discountApproval: { status: 'REJECTED', rejectedBy: req.user._id, rejectedAt: new Date(), reason: request.rejectionReason }
              };
            }
            await charge.save();
            await ipdFinancial.calculateAdmissionFinancials(charge.admissionId, { user: req.user });
          }
        } catch (chargeSyncErr) {
          console.warn('Could not sync approval decision to IPD charge:', chargeSyncErr.message);
        }
      }
    }

    return res.status(200).json({ success: true, request });
  } catch (error) {
    console.error('Error updating approval request:', error.message);
    return sendError(res, error);
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    const hospitalId = requestHospitalId(req);
    const request = await ApprovalRequest.findOneAndDelete({
      _id: req.params.id,
      hospitalId,
      status: 'Pending'
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Pending request not found or already processed.'
      });
    }

    return res.status(200).json({ success: true, message: 'Request cancelled successfully.' });
  } catch (error) {
    console.error('Error deleting approval request:', error.message);
    return sendError(res, error);
  }
};
