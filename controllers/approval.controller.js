const ApprovalRequest = require('../models/ApprovalRequest');
const Sale = require('../models/Sale');
const mongoose = require('mongoose');

exports.createRequest = async (req, res) => {
  try {
    const { requestType, patientId, admissionId, details } = req.body;
    
    console.log("DEBUG: createRequest req.user", req.user);
    console.log("DEBUG: createRequest req.hospital_id", req.hospital_id);
    console.log("DEBUG: createRequest req.hospitalId", req.hospitalId);
    
    console.log("DEBUG: createRequest req.headers['x-hospital-id']", req.headers['x-hospital-id']);
    
    let resolvedHospitalId = req.user?.hospital_id || req.user?.hospitalID || req.hospital_id || req.hospitalId || req.headers['x-hospital-id'] || req.body?.hospitalId;
    
    // Fallback: If still undefined, try to get from admission
    if (!resolvedHospitalId && admissionId) {
      const IPDAdmission = require('../models/IPDAdmission');
      const admission = await IPDAdmission.findById(admissionId);
      if (admission && admission.hospitalId) {
        resolvedHospitalId = admission.hospitalId;
      }
    }

    // Fallback 2: Get first hospital in DB (for demo accounts missing hospital_id)
    if (!resolvedHospitalId) {
      const Hospital = require('../models/Hospital');
      const hospital = await Hospital.findOne();
      if (hospital) {
        resolvedHospitalId = hospital._id;
      }
    }

    if (!resolvedHospitalId) {
      return res.status(400).json({ error: 'Hospital ID is required but could not be resolved from user, headers, body, or admission.' });
    }

    // Check if there is an existing pending request for this context to avoid duplicates
    if (admissionId && requestType) {
      const existing = await ApprovalRequest.findOne({
        hospitalId: resolvedHospitalId,
        requestType,
        admissionId,
        status: 'Pending'
      });
      if (existing) {
        return res.status(400).json({ error: 'A pending approval request already exists for this admission.' });
      }
    }

    const request = new ApprovalRequest({
      hospitalId: resolvedHospitalId,
      requestType,
      patientId,
      admissionId,
      details,
      requestedBy: req.user._id,
      status: 'Pending'
    });

    await request.save();
    res.status(201).json({ success: true, request });
  } catch (err) {
    console.error('Error creating approval request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getRequests = async (req, res) => {
  try {
    let resolvedHospitalId = req.user?.hospital_id || req.user?.hospitalID || req.hospital_id || req.hospitalId || req.headers['x-hospital-id'] || req.query?.hospitalId;
    
    if (!resolvedHospitalId) {
      const Hospital = require('../models/Hospital');
      const hospital = await Hospital.findOne();
      if (hospital) resolvedHospitalId = hospital._id;
    }

    const { status, requestType, admissionId } = req.query;
    
    const query = { hospitalId: resolvedHospitalId };
    if (status) query.status = status;
    if (requestType) query.requestType = requestType;
    if (admissionId) query.admissionId = admissionId;

    const requests = await ApprovalRequest.find(query)
      .populate('requestedBy', 'name email first_name last_name')
      .populate('approvedBy', 'name email first_name last_name')
      .populate({
        path: 'patientId',
        select: 'first_name last_name patientId uhid phone'
      })
      .populate({
        path: 'admissionId',
        select: 'admissionNumber'
      })
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, requests });
  } catch (err) {
    console.error('Error fetching approval requests:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status update.' });
    }

    let resolvedHospitalId = req.user?.hospital_id || req.user?.hospitalID || req.hospital_id || req.hospitalId || req.headers['x-hospital-id'] || req.body?.hospitalId;
    if (!resolvedHospitalId) {
      const Hospital = require('../models/Hospital');
      const hospital = await Hospital.findOne();
      if (hospital) resolvedHospitalId = hospital._id;
    }

    const request = await ApprovalRequest.findOne({
      _id: id,
      hospitalId: resolvedHospitalId
    });

    if (!request) {
      return res.status(404).json({ error: 'Request not found.' });
    }

    if (request.status !== 'Pending') {
      return res.status(400).json({ error: 'Request is already processed.' });
    }

    request.status = status;
    request.approvedBy = req.user._id;
    request.approvedAt = new Date();
    
    if (status === 'Rejected' && rejectionReason) {
      request.rejectionReason = rejectionReason;
    }

    await request.save();
    res.status(200).json({ success: true, request });
  } catch (err) {
    console.error('Error updating approval request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.deleteRequest = async (req, res) => {
  try {
    let resolvedHospitalId = req.user?.hospital_id || req.user?.hospitalID || req.hospital_id || req.hospitalId || req.headers['x-hospital-id'] || req.query?.hospitalId;
    if (!resolvedHospitalId) {
      const Hospital = require('../models/Hospital');
      const hospital = await Hospital.findOne();
      if (hospital) resolvedHospitalId = hospital._id;
    }

    const { id } = req.params;
    const request = await ApprovalRequest.findOneAndDelete({
      _id: id,
      hospitalId: resolvedHospitalId,
      status: 'Pending'
    });

    if (!request) {
      return res.status(404).json({ error: 'Pending request not found or already processed.' });
    }

    res.status(200).json({ success: true, message: 'Request cancelled successfully.' });
  } catch (err) {
    console.error('Error deleting approval request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
