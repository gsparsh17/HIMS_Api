const ApprovalRequest = require('../models/ApprovalRequest');
const IPDAdmission = require('../models/IPDAdmission');
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
