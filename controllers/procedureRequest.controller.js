const ProcedureRequest = require('../models/ProcedureRequest');
const Procedure = require('../models/Procedure');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============== PROCEDURE REQUEST CRUD ==============

// Create procedure request (from IPD/OPD)
exports.createProcedureRequest = async (req, res) => {
  try {
    const {
      sourceType,
      admissionId,
      appointmentId,
      prescriptionId,
      patientId,
      doctorId,
      procedureId,
      clinical_indication,
      clinical_history,
      priority,
      scheduledDate,
      anesthesia_type,
      pre_procedure_instructions,
      consent_obtained,
      patient_notes
    } = req.body;

    if (!patientId || !doctorId || !procedureId) {
      return res.status(400).json({ error: 'Patient, doctor, and procedure are required' });
    }

    // Get procedure details
    const procedure = await Procedure.findById(procedureId);
    if (!procedure) {
      return res.status(404).json({ error: 'Procedure not found' });
    }

    // Validate source-specific requirements
    if (sourceType === 'IPD' && !admissionId) {
      return res.status(400).json({ error: 'Admission ID is required for IPD requests' });
    }

    // Increment usage count
    await procedure.incrementUsage();

    const request = new ProcedureRequest({
      sourceType: sourceType || 'IPD',
      admissionId: admissionId || null,
      appointmentId: appointmentId || null,
      prescriptionId: prescriptionId || null,
      patientId,
      doctorId,
      procedureId,
      procedureCode: procedure.code,
      procedureName: procedure.name,
      category: procedure.category,
      subcategory: procedure.subcategory,
      clinical_indication: clinical_indication || '',
      clinical_history: clinical_history || '',
      priority: priority || 'Routine',
      scheduledDate: scheduledDate || null,
      estimated_duration_minutes: procedure.duration_minutes || 30,
      anesthesia_type: anesthesia_type || 'Local',
      pre_procedure_instructions: pre_procedure_instructions || procedure.pre_procedure_instructions || '',
      consent_obtained: consent_obtained || false,
      cost: procedure.base_price,
      createdBy: req.user?._id
    });

    await request.save();

    // Populate response
    const populated = await ProcedureRequest.findById(request._id)
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price');

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Error creating procedure request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get procedure requests (with filters)
exports.getProcedureRequests = async (req, res) => {
  try {
    const {
      status,
      patientId,
      doctorId,
      admissionId,
      appointmentId,
      sourceType,
      startDate,
      endDate,
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (appointmentId) filter.appointmentId = appointmentId;
    if (sourceType) filter.sourceType = sourceType;
    
    if (startDate || endDate) {
      filter.requestedDate = {};
      if (startDate) filter.requestedDate.$gte = new Date(startDate);
      if (endDate) filter.requestedDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const requests = await ProcedureRequest.find(filter)
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price')
      .populate('approvedBy', 'name')
      .populate('performedBy', 'name')
      .populate('completedBy', 'name')
      .sort({ requestedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ProcedureRequest.countDocuments(filter);

    res.json({
      success: true,
      data: requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching procedure requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get procedure request by ID
exports.getProcedureRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await ProcedureRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId phone dob gender')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price pre_procedure_instructions post_procedure_instructions')
      .populate('approvedBy', 'name')
      .populate('performedBy', 'name')
      .populate('completedBy', 'name');

    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching procedure request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update procedure request status
exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const userId = req.user?._id;

    const request = await ProcedureRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    const previousStatus = request.status;
    request.status = status;
    
    // Update timestamps based on status
    if (status === 'Approved' && previousStatus === 'Pending') {
      request.approvedBy = userId;
      request.approvedAt = new Date();
    } else if (status === 'In Progress') {
      request.performedBy = userId;
      request.performedAt = new Date();
    } else if (status === 'Completed') {
      request.completedBy = userId;
      request.completedAt = new Date();
    } else if (status === 'Cancelled') {
      request.cancelled_by = userId;
      request.cancelled_at = new Date();
      request.cancellation_reason = notes;
    }

    if (notes && status !== 'Cancelled') {
      if (status === 'In Progress') request.surgeon_notes = notes;
      else request.anesthesiologist_notes = notes;
    }

    await request.save();

    res.json({ 
      success: true, 
      message: `Request status updated to ${status}`, 
      data: request 
    });
  } catch (error) {
    console.error('Error updating request status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Add procedure findings/completion
exports.addProcedureFindings = async (req, res) => {
  try {
    const { id } = req.params;
    const { findings, complications, post_procedure_instructions } = req.body;

    const request = await ProcedureRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    request.findings = findings || '';
    request.complications = complications || '';
    request.post_procedure_instructions = post_procedure_instructions || '';

    if (request.status !== 'Completed') {
      request.status = 'Completed';
      request.completedBy = req.user?._id;
      request.completedAt = new Date();
    }

    await request.save();

    res.json({ 
      success: true, 
      message: 'Procedure findings added successfully', 
      data: request 
    });
  } catch (error) {
    console.error('Error adding procedure findings:', error);
    res.status(500).json({ error: error.message });
  }
};

// Upload attachment
exports.uploadAttachment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const request = await ProcedureRequest.findById(id);
    if (!request) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    // Upload to Cloudinary
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';
    
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'procedure_attachments',
      resource_type: resourceType,
      public_id: `proc_${request.requestNumber}_${Date.now()}`,
      access_mode: 'public'
    });

    fs.unlinkSync(req.file.path);

    request.attachments.push({
      name: name || req.file.originalname,
      url: result.secure_url,
      uploaded_by: req.user?._id,
      uploaded_at: new Date()
    });

    await request.save();

    res.json({ 
      success: true, 
      message: 'Attachment uploaded successfully', 
      attachment: request.attachments[request.attachments.length - 1] 
    });
  } catch (error) {
    console.error('Error uploading attachment:', error);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by admission (for IPD)
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await ProcedureRequest.find({ 
      admissionId, 
      sourceType: 'IPD' 
    })
      .populate('procedureId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by patient
exports.getRequestsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const requests = await ProcedureRequest.find({ patientId })
      .populate('procedureId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .populate('admissionId', 'admissionNumber admissionDate')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by patient:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get pending requests for IPD
exports.getPendingIPDRequests = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await ProcedureRequest.find({
      admissionId,
      sourceType: 'IPD',
      status: { $in: ['Pending', 'Approved', 'Scheduled'] }
    })
      .populate('procedureId', 'code name category estimated_duration_minutes')
      .sort({ priority: -1, requestedDate: 1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching pending IPD requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mark as billed
exports.markAsBilled = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId } = req.body;
    
    const request = await ProcedureRequest.findByIdAndUpdate(
      id,
      { is_billed: true, invoiceId },
      { new: true }
    );
    
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }
    
    res.json({ success: true, message: 'Request marked as billed', data: request });
  } catch (error) {
    console.error('Error marking as billed:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [pending, todayScheduled, totalRequests, completedToday] = await Promise.all([
      ProcedureRequest.countDocuments({ status: 'Pending' }),
      ProcedureRequest.countDocuments({ 
        scheduledDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Scheduled', 'Approved'] }
      }),
      ProcedureRequest.countDocuments(),
      ProcedureRequest.countDocuments({ 
        status: 'Completed',
        completedAt: { $gte: today, $lt: tomorrow }
      })
    ]);

    // Category-wise breakdown
    const categoryBreakdown = await ProcedureRequest.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      stats: {
        pending,
        todayScheduled,
        totalRequests,
        completedToday,
        categoryBreakdown
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};