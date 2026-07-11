const OTRequest = require('../models/OTRequest');
const OTStaff = require('../models/OTStaff');
const OTSchedule = require('../models/OTSchedule');
const Room = require('../models/Room');
const IPDAdmission = require('../models/IPDAdmission');
const Doctor = require('../models/Doctor');
const Procedure = require('../models/Procedure');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const mongoose = require('mongoose');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper function to get billing controller dynamically
async function getBillingController() {
  return require('./billing.controller');
}

// ============== OT REQUEST CRUD ==============

// Create OT Request (Doctor) - UPDATED: stays in Requested status, no billing yet
exports.createOTRequest = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      doctorId,
      procedureCode,
      procedureName,
      procedureCategory,
      clinical_indication,
      clinical_history,
      urgency,
      preferredDate,
      preferredTime,
      special_instructions,
      estimated_duration_minutes
    } = req.body;

    // Validate required fields
    if (!admissionId || !patientId || !doctorId || !procedureCode || !procedureName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify admission exists and is active
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission || admission.status === 'Discharged') {
      return res.status(404).json({ error: 'Active admission not found' });
    }

    // Get procedure details for estimated cost
    let estimated_cost = 0;
    const procedure = await Procedure.findOne({ code: procedureCode });
    if (procedure) {
      estimated_cost = procedure.base_price || 0;
    }

    const request = new OTRequest({
      admissionId,
      patientId,
      doctorId,
      procedureCode,
      procedureName,
      procedureCategory: procedureCategory || '',
      clinical_indication: clinical_indication || '',
      clinical_history: clinical_history || '',
      urgency: urgency || 'Elective',
      preferredDate: preferredDate ? new Date(preferredDate) : null,
      preferredTime: preferredTime || '',
      special_instructions: special_instructions || '',
      estimated_duration_minutes: estimated_duration_minutes || 60,
      estimated_cost: estimated_cost,
      total_cost: estimated_cost,  // Set total_cost = estimated_cost initially
      paymentStatus: 'Pending',
      status: 'Requested',  // Initial status - not yet paid
      createdBy: req.user ? req.user._id : undefined
    });

    await request.save();

    const populated = await OTRequest.findById(request._id)
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization');

    res.status(201).json({
      success: true,
      message: 'OT request submitted successfully. Payment is required before scheduling.',
      data: populated
    });
  } catch (error) {
    console.error('Error creating OT request:', error);
    res.status(500).json({ error: error.message });
  }
};

// NEW: Process payment for OT request (like lab tests and procedures)
exports.processOTPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method, amount, reference, notes } = req.body;

    const request = await OTRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId phone');

    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    if (request.status === 'Completed') {
      return res.status(400).json({ error: 'Completed surgeries cannot be billed' });
    }

    if (request.is_billed) {
      return res.status(409).json({ error: 'OT request already has a bill' });
    }

    const paymentAmount = amount || request.total_cost;
    const finalStatus = paymentAmount >= request.total_cost ? 'Paid' : 'Generated';

    // Create bill items
    const billItems = [{
      description: `${request.procedureCode} - ${request.procedureName}`,
      amount: request.total_cost,
      quantity: 1,
      item_type: 'Procedure',
      procedure_code: request.procedureCode,
      procedure_id: request._id,
      prescription_id: null,
      admission_id: request.admissionId
    }];

    // Call billing controller to create bill
    const billingController = await getBillingController();

    // Create a mock request object for billing controller
    const mockReq = {
      body: {
        patient_id: request.patientId,
        admission_id: request.admissionId,
        items: billItems,
        total_amount: request.total_cost,
        subtotal: request.total_cost,
        payment_method: payment_method,
        status: finalStatus,
        notes: notes || `OT Procedure: ${request.procedureName} - ${request.requestNumber}`
      },
      user: req.user
    };

    const mockRes = {
      status: function (code) { this.statusCode = code; return this; },
      json: function (data) { this.data = data; return this; }
    };

    await billingController.createBill(mockReq, mockRes);

    if (mockRes.data && mockRes.data.success) {
      const bill = mockRes.data.bill;
      const invoice = mockRes.data.invoice;

      // Update OT request with billing info
      request.is_billed = true;
      request.billId = bill._id;
      request.invoiceId = invoice?._id;
      request.paidAmount = finalStatus === 'Paid' ? request.total_cost : paymentAmount;
      request.dueAmount = request.total_cost - request.paidAmount;
      request.paymentStatus = finalStatus === 'Paid' ? 'Completed' : 'Partial';
      request.paymentReceivedAt = new Date();
      request.paymentReceivedBy = req.user?._id;

      // Update status to move forward
      if (finalStatus === 'Paid') {
        request.status = 'Payment Received';
      } else {
        request.status = 'Payment Pending';
      }

      await request.save();

      res.json({
        success: true,
        message: `Payment processed successfully. OT request is now ${request.status}.`,
        bill: bill,
        invoice: invoice,
        request: {
          id: request._id,
          requestNumber: request.requestNumber,
          status: request.status,
          paymentStatus: request.paymentStatus,
          paidAmount: request.paidAmount,
          dueAmount: request.dueAmount
        }
      });
    } else {
      throw new Error(mockRes.data?.error || 'Failed to create bill');
    }
  } catch (error) {
    console.error('Error processing OT payment:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get OT requests with filters - UPDATED to include payment status
exports.getOTRequests = async (req, res) => {
  try {
    const {
      status,
      paymentStatus,
      admissionId,
      patientId,
      doctorId,
      urgency,
      startDate,
      endDate,
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (admissionId) filter.admissionId = admissionId;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (urgency) filter.urgency = urgency;

    if (startDate && endDate) {
      filter.requestedDate = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else if (startDate) {
      filter.requestedDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      filter.requestedDate = { $lte: new Date(endDate) };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const requests = await OTRequest.find(filter)
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('primarySurgeonId', 'firstName lastName specialization')
      .populate('assistantSurgeonId', 'firstName lastName specialization')
      .populate('anesthetistId', 'firstName lastName specialization')
      .populate('scrubNurseId', 'first_name last_name')
      .populate('circulatingNurseId', 'first_name last_name')
      .populate('otStaffId', 'employeeId designation')
      .populate('otRoomId', 'room_number type floor status')
      .populate('post_op_wardId', 'name')
      .populate('post_op_roomId', 'room_number')
      .populate('post_op_bedId', 'bedNumber bedType')
      .sort({ scheduledDate: 1, requestedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await OTRequest.countDocuments(filter);

    res.json({
      success: true,
      data: requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Error fetching OT requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get OT request by ID - UPDATED with payment info
exports.getOTRequestById = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await OTRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId dob gender phone address')
      .populate('doctorId', 'firstName lastName specialization department')
      .populate('primarySurgeonId', 'firstName lastName specialization')
      .populate('assistantSurgeonId', 'firstName lastName specialization')
      .populate('anesthetistId', 'firstName lastName specialization')
      .populate('scrubNurseId', 'first_name last_name')
      .populate('circulatingNurseId', 'first_name last_name')
      .populate('otStaffId', 'employeeId designation qualification')
      .populate('otRoomId', 'room_number type floor status')
      .populate('post_op_wardId', 'name')
      .populate('post_op_roomId', 'room_number')
      .populate('post_op_bedId', 'bedNumber bedType')
      .populate('billId')
      .populate('invoiceId');

    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching OT request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update OT request status - UPDATED with validation
exports.updateOTRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    const oldStatus = request.status;

    // Validate status transitions
    const validTransitions = {
      'Requested': ['Payment Pending', 'Cancelled'],
      'Payment Pending': ['Payment Received', 'Cancelled'],
      'Payment Received': ['Approved', 'Cancelled'],
      'Approved': ['Scheduled', 'Cancelled'],
      'Scheduled': ['In Progress', 'Cancelled', 'Postponed'],
      'In Progress': ['Completed', 'Cancelled'],
      'Completed': [],
      'Cancelled': [],
      'Postponed': ['Scheduled', 'Cancelled']
    };

    if (validTransitions[request.status] && !validTransitions[request.status].includes(status)) {
      return res.status(400).json({
        error: `Invalid status transition from ${request.status} to ${status}`
      });
    }

    request.status = status;

    if (status === 'Approved') {
      request.approvedBy = req.user ? req.user._id : undefined;
      request.approvedAt = new Date();
    }

    await request.save();

    res.json({
      success: true,
      message: `Request status updated from ${oldStatus} to ${status}`,
      data: request
    });
  } catch (error) {
    console.error('Error updating OT request status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Assign OT Room and Team - UPDATED: requires payment received
exports.assignOTRoom = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      otRoomId,
      scheduledDate,
      scheduledTime,
      primarySurgeonId,
      assistantSurgeonId,
      anesthetistId,
      scrubNurseId,
      circulatingNurseId,
      otStaffId,
      notes
    } = req.body;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    // Check if payment is completed before scheduling
    if (request.paymentStatus !== 'Completed') {
      return res.status(400).json({
        error: 'Payment must be completed before scheduling. Please process payment first.',
        paymentStatus: request.paymentStatus,
        dueAmount: request.dueAmount
      });
    }

    if (request.status !== 'Payment Received' && request.status !== 'Approved') {
      return res.status(400).json({
        error: `Request cannot be assigned in current status: ${request.status}`
      });
    }

    // Verify OT room exists and is available
    if (otRoomId) {
      const otRoom = await Room.findById(otRoomId);
      if (!otRoom) {
        return res.status(404).json({ error: 'OT room not found' });
      }
      if (otRoom.type !== 'Operation Theater') {
        return res.status(400).json({ error: 'Selected room is not an Operation Theater' });
      }
      if (otRoom.status !== 'Available') {
        return res.status(400).json({ error: 'OT room is not available' });
      }

      await Room.findByIdAndUpdate(otRoomId, { status: 'Reserved' });
    }

    // Verify surgeons exist
    if (primarySurgeonId) {
      const surgeon = await Doctor.findById(primarySurgeonId);
      if (!surgeon) {
        return res.status(404).json({ error: 'Primary surgeon not found' });
      }
    }

    if (anesthetistId) {
      const anesthetist = await Doctor.findById(anesthetistId);
      if (!anesthetist) {
        return res.status(404).json({ error: 'Anesthetist not found' });
      }
    }

    // Update request
    request.otRoomId = otRoomId || request.otRoomId;
    request.scheduledDate = scheduledDate ? new Date(scheduledDate) : request.scheduledDate;
    request.scheduledTime = scheduledTime || request.scheduledTime;
    request.primarySurgeonId = primarySurgeonId || request.primarySurgeonId;
    request.assistantSurgeonId = assistantSurgeonId || request.assistantSurgeonId;
    request.anesthetistId = anesthetistId || request.anesthetistId;
    request.scrubNurseId = scrubNurseId || request.scrubNurseId;
    request.circulatingNurseId = circulatingNurseId || request.circulatingNurseId;
    request.otStaffId = otStaffId || request.otStaffId;
    request.status = 'Scheduled';
    request.approvedBy = req.user ? req.user._id : undefined;
    request.approvedAt = new Date();

    await request.save();

    // Create schedule entry
    const schedule = new OTSchedule({
      otRoomId,
      requestId: request._id,
      scheduledDate: request.scheduledDate,
      startTime: request.scheduledTime,
      duration_minutes: request.estimated_duration_minutes,
      status: 'Scheduled',
      notes: notes || ''
    });
    await schedule.save();

    res.json({
      success: true,
      message: 'OT request assigned successfully',
      data: request,
      schedule
    });
  } catch (error) {
    console.error('Error assigning OT request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Start Surgery - UPDATED: requires payment completed
exports.startSurgery = async (req, res) => {
  try {
    const { id } = req.params;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    if (request.paymentStatus !== 'Completed') {
      return res.status(400).json({
        error: 'Payment must be completed before starting surgery'
      });
    }

    if (request.status !== 'Scheduled') {
      return res.status(400).json({ error: 'Only scheduled requests can be started' });
    }

    request.status = 'In Progress';
    request.startedAt = new Date();

    await request.save();

    // Update schedule
    await OTSchedule.findOneAndUpdate(
      { requestId: request._id },
      { status: 'In Progress' }
    );

    // Update OT room status to Occupied
    if (request.otRoomId) {
      await Room.findByIdAndUpdate(request.otRoomId, { status: 'Occupied' });
    }

    res.json({
      success: true,
      message: 'Surgery started successfully',
      data: request
    });
  } catch (error) {
    console.error('Error starting surgery:', error);
    res.status(500).json({ error: error.message });
  }
};

// Complete Surgery
exports.completeSurgery = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      findings,
      complications,
      procedure_performed,
      blood_loss_ml,
      anesthesia_notes,
      surgeon_notes,
      post_op_diagnosis,
      post_op_instructions,
      consumables,
      implants,
      total_cost
    } = req.body;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    if (request.status !== 'In Progress') {
      return res.status(400).json({ error: 'Only in-progress surgeries can be completed' });
    }

    const completedAt = new Date();
    const actualDuration = Math.round((completedAt - request.startedAt) / 60000);

    // Update final cost if different from estimated
    if (total_cost && total_cost !== request.total_cost) {
      request.total_cost = total_cost;
      request.dueAmount = request.total_cost - request.paidAmount;
    }

    request.status = 'Completed';
    request.completedAt = completedAt;
    request.findings = findings || '';
    request.complications = complications || '';
    request.procedure_performed = procedure_performed || request.procedureName;
    request.blood_loss_ml = blood_loss_ml || 0;
    request.anesthesia_notes = anesthesia_notes || '';
    request.surgeon_notes = surgeon_notes || '';
    request.post_op_diagnosis = post_op_diagnosis || '';
    request.post_op_instructions = post_op_instructions || '';
    request.consumables = consumables || [];
    request.implants = implants || [];

    await request.save();

    // Update schedule
    await OTSchedule.findOneAndUpdate(
      { requestId: request._id },
      {
        status: 'Completed',
        endTime: completedAt.toLocaleTimeString(),
        duration_minutes: actualDuration
      }
    );

    // Release OT room
    if (request.otRoomId) {
      await Room.findByIdAndUpdate(request.otRoomId, { status: 'Cleaning' });
    }

    res.json({
      success: true,
      message: 'Surgery completed successfully',
      data: {
        request,
        actual_duration_minutes: actualDuration
      }
    });
  } catch (error) {
    console.error('Error completing surgery:', error);
    res.status(500).json({ error: error.message });
  }
};

// Cancel OT Request - UPDATED to handle refunds
exports.cancelOTRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { cancellationReason, refundAmount } = req.body;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    if (request.status === 'Completed') {
      return res.status(400).json({ error: 'Completed surgeries cannot be cancelled' });
    }

    const oldStatus = request.status;
    request.status = 'Cancelled';
    request.cancelledBy = req.user ? req.user._id : undefined;
    request.cancelledAt = new Date();
    request.cancellationReason = cancellationReason || 'No reason provided';

    // Handle refund if payment was made
    if (request.paidAmount > 0 && refundAmount) {
      request.paidAmount = request.paidAmount - refundAmount;
      request.dueAmount = request.total_cost - request.paidAmount;

      if (request.paidAmount === 0) {
        request.paymentStatus = 'Refunded';
      } else {
        request.paymentStatus = 'Partial';
      }
    }

    await request.save();

    // Update schedule if exists
    await OTSchedule.findOneAndUpdate(
      { requestId: request._id },
      { status: 'Cancelled' }
    );

    // Release OT room if it was assigned
    if (request.otRoomId) {
      await Room.findByIdAndUpdate(request.otRoomId, { status: 'Available' });
    }

    res.json({
      success: true,
      message: `OT request cancelled (was ${oldStatus})`,
      data: request
    });
  } catch (error) {
    console.error('Error cancelling OT request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Upload Surgery Report
exports.uploadSurgeryReport = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const request = await OTRequest.findById(id);
    if (!request) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'OT request not found' });
    }

    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';

    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'ot_reports',
      resource_type: resourceType,
      public_id: `OT_${request.requestNumber}_${Date.now()}`,
      access_mode: 'public'
    });

    fs.unlinkSync(req.file.path);

    const attachment = {
      name: req.file.originalname,
      url: result.secure_url,
      uploaded_by: req.user ? req.user._id : undefined,
      uploaded_at: new Date()
    };

    request.attachments.push(attachment);
    request.surgery_report_url = result.secure_url;
    await request.save();

    res.json({
      success: true,
      message: 'Surgery report uploaded successfully',
      report_url: result.secure_url,
      attachment
    });
  } catch (error) {
    console.error('Error uploading report:', error);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
};

// Download Surgery Report
exports.downloadSurgeryReport = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await OTRequest.findById(id);

    if (!request || !request.surgery_report_url) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.redirect(request.surgery_report_url);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ error: error.message });
  }
};

// Transfer Patient Post-Operative
exports.transferPatientPostOp = async (req, res) => {
  try {
    const { id } = req.params;
    const { post_op_wardId, post_op_roomId, post_op_bedId } = req.body;

    const request = await OTRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    if (request.status !== 'Completed') {
      return res.status(400).json({ error: 'Only completed surgeries can transfer patient' });
    }

    const admission = await IPDAdmission.findById(request.admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (post_op_bedId) {
      const newBed = await require('../models/Bed').findById(post_op_bedId);
      if (newBed && newBed.status !== 'Available') {
        return res.status(400).json({ error: 'Selected bed is not available' });
      }

      if (admission.bedId) {
        await require('../models/Bed').findByIdAndUpdate(admission.bedId, {
          status: 'Available',
          currentAdmissionId: null
        });
      }

      await require('../models/Bed').findByIdAndUpdate(post_op_bedId, {
        status: 'Occupied',
        currentAdmissionId: admission._id
      });

      admission.bedId = post_op_bedId;
    }

    if (post_op_roomId) admission.roomId = post_op_roomId;
    if (post_op_wardId) admission.wardId = post_op_wardId;

    await admission.save();

    request.post_op_wardId = post_op_wardId || null;
    request.post_op_roomId = post_op_roomId || null;
    request.post_op_bedId = post_op_bedId || null;
    request.transferred_to_ward = true;
    request.transferred_at = new Date();

    await request.save();

    res.json({
      success: true,
      message: 'Patient transferred successfully',
      data: {
        request,
        admission: {
          wardId: admission.wardId,
          roomId: admission.roomId,
          bedId: admission.bedId
        }
      }
    });
  } catch (error) {
    console.error('Error transferring patient:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mark as billed (legacy - kept for compatibility)
exports.markAsBilled = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId } = req.body;

    const request = await OTRequest.findByIdAndUpdate(
      id,
      { is_billed: true, invoiceId },
      { new: true }
    );

    if (!request) {
      return res.status(404).json({ error: 'OT request not found' });
    }

    res.json({
      success: true,
      message: 'OT request marked as billed',
      data: request
    });
  } catch (error) {
    console.error('Error marking as billed:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.createOTStaff = async (req, res) => {
  try {
    const {
      userId,
      employeeId,
      designation,
      specializations,
      qualification,
      experience_years,
      is_active,
      joined_date
    } = req.body;

    if (!userId || !employeeId || !designation) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await OTStaff.findOne({ employeeId });
    if (existing) {
      return res.status(400).json({ error: 'Employee ID already exists' });
    }

    const otStaff = new OTStaff({
      userId,
      employeeId,
      designation,
      specializations: specializations || [],
      qualification: qualification || '',
      experience_years: experience_years || 0,
      is_active: is_active !== undefined ? is_active : true,
      joined_date: joined_date || new Date()
    });

    await otStaff.save();
    await syncHRProfileFromSource('OTStaff', otStaff, { hospital_id: req.user?.hospital_id || undefined });

    const populated = await OTStaff.findById(otStaff._id).populate('userId', 'name email phone');

    res.status(201).json({
      success: true,
      message: 'OT staff created successfully',
      data: populated
    });
  } catch (error) {
    console.error('Error creating OT staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get OT Staff
exports.getOTStaff = async (req, res) => {
  try {
    const { is_active, designation } = req.query;
    const filter = {};
    if (is_active !== undefined) filter.is_active = is_active === 'true';
    if (designation) filter.designation = designation;

    const staff = await OTStaff.find(filter)
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: staff,
      count: staff.length
    });
  } catch (error) {
    console.error('Error fetching OT staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Available OT Staff (active only)
exports.getAvailableOTStaff = async (req, res) => {
  try {
    const staff = await OTStaff.find({ is_active: true })
      .populate('userId', 'name email')
      .sort({ designation: 1 });

    res.json({
      success: true,
      data: staff
    });
  } catch (error) {
    console.error('Error fetching available OT staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update OT Staff
exports.updateOTStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const staff = await OTStaff.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!staff) {
      return res.status(404).json({ error: 'OT staff not found' });
    }

    const populated = await OTStaff.findById(staff._id).populate('userId', 'name email phone');

    res.json({
      success: true,
      message: 'OT staff updated successfully',
      data: populated
    });
  } catch (error) {
    console.error('Error updating OT staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// Toggle OT Staff Status (activate/deactivate)
exports.toggleOTStaffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await OTStaff.findById(id);

    if (!staff) {
      return res.status(404).json({ error: 'OT staff not found' });
    }

    staff.is_active = !staff.is_active;
    await staff.save();

    res.json({
      success: true,
      message: `OT staff ${staff.is_active ? 'activated' : 'deactivated'} successfully`,
      data: { is_active: staff.is_active }
    });
  } catch (error) {
    console.error('Error toggling OT staff status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete OT Staff
exports.deleteOTStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await OTStaff.findByIdAndDelete(id);

    if (!staff) {
      return res.status(404).json({ error: 'OT staff not found' });
    }

    res.json({
      success: true,
      message: 'OT staff deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting OT staff:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============== OT ROOM UTILITIES (using existing Room model) ==============

// Get OT Rooms (rooms with type 'Operation Theater')
exports.getOTRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { type: 'Operation Theater' },
        { type: { $regex: 'Operation', $options: 'i' } }
      ]
    }).populate('wardId', 'name').populate('Department', 'name');

    res.json({
      success: true,
      data: rooms,
      count: rooms.length
    });
  } catch (error) {
    console.error('Error fetching OT rooms:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Available OT Rooms
exports.getAvailableOTRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { type: 'Operation Theater' },
        { type: { $regex: 'Operation', $options: 'i' } }
      ],
      status: 'Available'
    }).populate('wardId', 'name');

    res.json({
      success: true,
      data: rooms
    });
  } catch (error) {
    console.error('Error fetching available OT rooms:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============== SPECIALIZED QUERIES ==============

// Get requests by admission
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await OTRequest.find({ admissionId })
      .populate('doctorId', 'firstName lastName')
      .populate('primarySurgeonId', 'firstName lastName')
      .populate('otRoomId', 'room_number')
      .sort({ requestedDate: -1 });

    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by doctor
exports.getRequestsByDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const requests = await OTRequest.find({ doctorId })
      .populate('patientId', 'first_name last_name patientId')
      .populate('otRoomId', 'room_number')
      .sort({ requestedDate: -1 });

    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by doctor:', error);
    res.status(500).json({ error: error.message });
  }
};
exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [
      pending,
      pendingPayment,
      todayScheduled,
      totalRequests,
      completedToday,
      inProgress,
      cancelled
    ] = await Promise.all([
      OTRequest.countDocuments({ status: 'Requested' }),
      OTRequest.countDocuments({ paymentStatus: 'Pending', status: { $ne: 'Completed' } }),
      OTRequest.countDocuments({
        scheduledDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Scheduled'] }
      }),
      OTRequest.countDocuments(),
      OTRequest.countDocuments({
        status: 'Completed',
        completedAt: { $gte: today, $lt: tomorrow }
      }),
      OTRequest.countDocuments({ status: 'In Progress' }),
      OTRequest.countDocuments({ status: 'Cancelled' })
    ]);

    const availableRooms = await Room.countDocuments({
      type: 'Operation Theater',
      status: 'Available'
    });

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59);

    const monthlyRevenue = await OTRequest.aggregate([
      {
        $match: {
          status: 'Completed',
          completedAt: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$total_cost' }
        }
      }
    ]);

    res.json({
      success: true,
      stats: {
        pending,
        pendingPayment,
        todayScheduled,
        totalRequests,
        completedToday,
        inProgress,
        cancelled,
        availableRooms,
        monthlyRevenue: monthlyRevenue[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Daily Schedule - UPDATED to show only payment-completed requests
exports.getDailySchedule = async (req, res) => {
  try {
    const { date } = req.params;
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(targetDate.getDate() + 1);

    const requests = await OTRequest.find({
      scheduledDate: { $gte: targetDate, $lt: nextDate },
      status: { $in: ['Scheduled', 'In Progress', 'Completed'] },
      paymentStatus: 'Completed'  // Only show paid requests
    })
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName')
      .populate('primarySurgeonId', 'firstName lastName')
      .populate('anesthetistId', 'firstName lastName')
      .populate('otRoomId', 'room_number floor')
      .populate('scrubNurseId', 'firstName lastName')
      .populate('circulatingNurseId', 'firstName lastName')
      .sort({ scheduledTime: 1 });

    res.json({
      success: true,
      date: targetDate,
      schedule: requests,
      count: requests.length
    });
  } catch (error) {
    console.error('Error fetching daily schedule:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Monthly Reports
exports.getMonthlyReports = async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const data = await OTRequest.aggregate([
      {
        $match: {
          status: 'Completed',
          completedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$completedAt" } },
          surgeries: { $sum: 1 },
          revenue: { $sum: "$total_cost" }
        }
      },
      {
        $project: {
          month: "$_id",
          surgeries: 1,
          revenue: 1,
          _id: 0
        }
      },
      { $sort: { month: 1 } }
    ]);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching monthly reports:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Procedure Stats
exports.getProcedureStats = async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const data = await OTRequest.aggregate([
      {
        $match: {
          status: 'Completed',
          completedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: "$procedureName",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          name: "$_id",
          count: 1,
          _id: 0
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching procedure stats:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Surgeon Stats
exports.getSurgeonStats = async (req, res) => {
  try {
    const { start, end } = req.query;
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const data = await OTRequest.aggregate([
      {
        $match: {
          status: 'Completed',
          completedAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: 'primarySurgeonId',
          foreignField: '_id',
          as: 'surgeon'
        }
      },
      { $unwind: { path: "$surgeon", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$primarySurgeonId",
          name: { $first: { $concat: ["$surgeon.firstName", " ", "$surgeon.lastName"] } },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching surgeon stats:', error);
    res.status(500).json({ error: error.message });
  }
};

// Export Reports
exports.exportOTReports = async (req, res) => {
  try {
    const { type } = req.params;
    const { start, end } = req.query;
    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const requests = await OTRequest.find({
      status: 'Completed',
      completedAt: { $gte: startDate, $lte: endDate }
    }).populate('patientId', 'first_name last_name patientId')
      .populate('primarySurgeonId', 'firstName lastName')
      .sort({ completedAt: 1 });

    let csv = '';
    if (type === 'summary') {
      csv = 'Month,Surgeries,Revenue\n';
      const monthly = {};
      requests.forEach(r => {
        const month = r.completedAt.toISOString().slice(0, 7);
        if (!monthly[month]) monthly[month] = { count: 0, revenue: 0 };
        monthly[month].count++;
        monthly[month].revenue += (r.total_cost || 0);
      });
      Object.keys(monthly).sort().forEach(m => {
        csv += `${m},${monthly[m].count},${monthly[m].revenue}\n`;
      });
    } else {
      csv = 'Date,Patient,Patient ID,Procedure,Surgeon,Cost\n';
      requests.forEach(r => {
        const date = r.completedAt.toISOString().split('T')[0];
        const patientName = `${r.patientId?.first_name || ''} ${r.patientId?.last_name || ''}`.trim();
        const surgeonName = `${r.primarySurgeonId?.firstName || ''} ${r.primarySurgeonId?.lastName || ''}`.trim();
        csv += `"${date}","${patientName}","${r.patientId?.patientId || ''}","${r.procedureName}","${surgeonName}",${r.total_cost || 0}\n`;
      });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=ot_report_${type}.csv`);
    res.status(200).send(csv);
  } catch (error) {
    console.error('Error exporting reports:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by admission
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await OTRequest.find({ admissionId })
      .populate('doctorId', 'firstName lastName')
      .populate('primarySurgeonId', 'firstName lastName')
      .populate('otRoomId', 'room_number')
      .sort({ requestedDate: -1 });

    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by doctor
exports.getRequestsByDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const requests = await OTRequest.find({ doctorId })
      .populate('patientId', 'first_name last_name patientId')
      .populate('otRoomId', 'room_number')
      .sort({ requestedDate: -1 });

    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by doctor:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get OT Rooms
exports.getOTRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { type: 'Operation Theater' },
        { type: { $regex: 'Operation', $options: 'i' } }
      ]
    }).populate('wardId', 'name').populate('Department', 'name');

    res.json({
      success: true,
      data: rooms,
      count: rooms.length
    });
  } catch (error) {
    console.error('Error fetching OT rooms:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get Available OT Rooms
exports.getAvailableOTRooms = async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { type: 'Operation Theater' },
        { type: { $regex: 'Operation', $options: 'i' } }
      ],
      status: 'Available'
    }).populate('wardId', 'name');

    res.json({
      success: true,
      data: rooms
    });
  } catch (error) {
    console.error('Error fetching available OT rooms:', error);
    res.status(500).json({ error: error.message });
  }
};
