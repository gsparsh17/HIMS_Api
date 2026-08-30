const { operationNow } = require('../utils/operationTimeContext');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const ProcedureRequest = require('../models/ProcedureRequest');
const Procedure = require('../models/Procedure');
const IPDAdmission = require('../models/IPDAdmission');
const fileStorage = require('../services/fileStorage.service');
const fs = require('fs');
const { requireHospitalId } = require('../services/tenantScope.service');
const { resolveRequestPayerContext, rememberRequestPayerContextUsage } = require('../services/requestPayerContext.service');
const { postSourceCharge, reverseSourceFinancials } = require('../services/chargePosting.service');
const { assertAdmissionOpenForMutation } = require('../services/ipdLifecycleGuard.service');



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
      patient_notes,
      coverage
    } = req.body;

    if (!patientId || !doctorId || !procedureId) {
      return res.status(400).json({ error: 'Patient, doctor, and procedure are required' });
    }

    const hospitalId = requireHospitalId(req);

    // Get procedure details from this hospital only.
    const procedure = await Procedure.findOne({ _id: procedureId, hospitalId, is_active: { $ne: false } });
    if (!procedure) {
      return res.status(404).json({ error: 'Procedure not found' });
    }

    // Validate source-specific requirements
    if (sourceType === 'IPD' && !admissionId) {
      return res.status(400).json({ error: 'Admission ID is required for IPD requests' });
    }
    if (sourceType === 'IPD') {
      const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).select('patientId status chargeFreeze');
      if (!admission || String(admission.patientId) !== String(patientId)) {
        return res.status(409).json({ error: 'Admission does not belong to the selected patient' });
      }
      try {
        assertAdmissionOpenForMutation(admission, { action: 'IPD clinical request creation' });
      } catch (guardError) {
        return res.status(guardError.statusCode || 409).json({ error: guardError.message, code: guardError.code });
      }
    }

    // Increment usage count
    await procedure.incrementUsage();

    const payerContext = await resolveRequestPayerContext({
      hospitalId,
      patientId,
      sourceType: sourceType || 'IPD',
      admissionId,
      appointmentId,
      declaredCoverage: coverage,
      userId: req.user?._id,
      rememberSource: 'PROCEDURE'
    });

    const request = new ProcedureRequest({
      hospitalId,
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
      payerContext: payerContext || undefined,
      createdBy: req.user?._id
    });

    await request.save();
    await rememberRequestPayerContextUsage({
      hospitalId,
      patientId,
      payerContext,
      source: 'PROCEDURE',
      encounterId: admissionId || appointmentId || request._id,
      userId: req.user?._id,
      usedAt: request.createdAt || operationNow()
    });

    // Automatic source finance for ProcedureRequest: creating the clinical request creates/reuses
    // the authoritative obligation. Pricing/clearance failures do not delete the clinical
    // order; the request remains PENDING_CHARGE and can be resumed from Front Desk/Finance.
    let financial = null;
    let financialWarning = null;
    if ((request.sourceType === 'IPD' && request.admissionId) || (request.sourceType === 'OPD' && request.appointmentId)) {
      try {
        financial = await postSourceCharge({
          sourceModule: 'ProcedureRequest',
          sourceId: request._id,
          idempotencyKey: `ProcedureRequest:${request._id}:charge`,
          user: req.user
        });
      } catch (financeError) {
        financialWarning = { code: financeError.code || 'SOURCE_FINANCE_PENDING', message: financeError.message };
        console.warn('ProcedureRequest automatic source-finance pending:', financeError.message);
      }
    }

    // Populate response
    const populated = await ProcedureRequest.findOne({ _id: request._id, hospitalId })
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price');

    res.status(201).json({ success: true, data: populated, financial: financial ? { chargeId: financial.charge?._id || null, billId: financial.bill?._id || null, invoiceId: financial.invoice?._id || null, financialPolicy: financial.financialPolicy || null } : null, financialWarning });
  } catch (error) {
    console.error('Error creating procedure request:', error);
    const status = Number(error?.statusCode || (['ValidationError', 'CastError'].includes(error?.name) ? 400 : 500));
    res.status(status).json({ error: error.code || error.message, message: error.message, code: error.code });
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

    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (appointmentId) filter.appointmentId = appointmentId;
    if (sourceType) filter.sourceType = sourceType;
    
    if (startDate || endDate) {
      filter.requestedDate = semanticDateRange(startDate, endDate);
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
    const hospitalId = requireHospitalId(req);
    const request = await ProcedureRequest.findOne({ _id: id, hospitalId })
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
    if (status === 'Cancelled' && !String(notes || '').trim()) {
      return res.status(400).json({ error: 'Cancellation reason is required so the financial reversal is auditable' });
    }
    const userId = req.user?._id;
    const hospitalId = requireHospitalId(req);

    const request = await ProcedureRequest.findOne({ _id: id, hospitalId });
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    const previousStatus = request.status;
    request.status = status;
    
    // Update timestamps based on status
    if (status === 'Approved' && previousStatus === 'Pending') {
      request.approvedBy = userId;
      request.approvedAt = operationNow();
    } else if (status === 'In Progress') {
      request.performedBy = userId;
      request.performedAt = operationNow();
    } else if (status === 'Completed') {
      request.completedBy = userId;
      request.completedAt = operationNow();
    } else if (status === 'Cancelled') {
      request.cancelled_by = userId;
      request.cancelled_at = operationNow();
      request.cancellation_reason = notes;
    }

    if (notes && status !== 'Cancelled') {
      if (status === 'In Progress') request.surgeon_notes = notes;
      else request.anesthesiologist_notes = notes;
    }

    await request.save();

    let financialReversal = null;
    let financialWarning = null;
    if (status === 'Cancelled') {
      try {
        financialReversal = await reverseSourceFinancials({ sourceModule: 'ProcedureRequest', sourceId: request._id, reason: notes, user: req.user });
      } catch (financeError) {
        financialWarning = financeError.message;
        console.warn('ProcedureRequest cancellation financial reversal pending:', financeError.message);
      }
    }

    res.json({ 
      success: true, 
      message: `Request status updated to ${status}`, 
      data: request,
      financialReversal,
      financialWarning
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
    const hospitalId = requireHospitalId(req);

    const request = await ProcedureRequest.findOne({ _id: id, hospitalId });
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    request.findings = findings || '';
    request.complications = complications || '';
    request.post_procedure_instructions = post_procedure_instructions || '';

    if (request.status !== 'Completed') {
      request.status = 'Completed';
      request.completedBy = req.user?._id;
      request.completedAt = operationNow();
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
    const hospitalId = requireHospitalId(req);

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const request = await ProcedureRequest.findOne({ _id: id, hospitalId });
    if (!request) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    // Upload through the configured HIMS storage driver
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';
    
    const result = await fileStorage.upload(req.file, req, {
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
      uploaded_at: operationNow()
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
// ============== ADMISSION-BASED QUERIES ==============

// Get procedure requests by admission (for IPD patient file)
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    if (!admissionId) {
      return res.status(400).json({ error: 'Admission ID is required' });
    }
    
    const hospitalId = requireHospitalId(req);
    const requests = await ProcedureRequest.find({ 
      hospitalId, admissionId, 
      sourceType: 'IPD' 
    })
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price pre_procedure_instructions')
      .populate('performedBy', 'name')
      .populate('approvedBy', 'name')
      .populate('completedBy', 'name')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching procedure requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get pending procedure requests for IPD admission
exports.getPendingIPDRequests = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    if (!admissionId) {
      return res.status(400).json({ error: 'Admission ID is required' });
    }
    
    const hospitalId = requireHospitalId(req);
    const requests = await ProcedureRequest.find({
      hospitalId, admissionId,
      sourceType: 'IPD',
      status: { $in: ['Pending', 'Approved', 'Scheduled'] }
    })
      .populate('procedureId', 'code name category estimated_duration_minutes')
      .populate('doctorId', 'firstName lastName')
      .sort({ priority: -1, requestedDate: 1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching pending IPD procedure requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get procedure requests by patient
exports.getRequestsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    
    if (!patientId) {
      return res.status(400).json({ error: 'Patient ID is required' });
    }
    
    const hospitalId = requireHospitalId(req);
    const requests = await ProcedureRequest.find({ hospitalId, patientId })
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

// Mark as billed
exports.markAsBilled = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId } = req.body;
    const hospitalId = requireHospitalId(req);
    
    const request = await ProcedureRequest.findOneAndUpdate(
      { _id: id, hospitalId },
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
    const hospitalId = requireHospitalId(req);
    const today = operationNow();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [pending, todayScheduled, totalRequests, completedToday] = await Promise.all([
      ProcedureRequest.countDocuments({ hospitalId, status: 'Pending' }),
      ProcedureRequest.countDocuments({ 
        hospitalId, scheduledDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Scheduled', 'Approved'] }
      }),
      ProcedureRequest.countDocuments({ hospitalId }),
      ProcedureRequest.countDocuments({ 
        hospitalId, status: 'Completed',
        completedAt: { $gte: today, $lt: tomorrow }
      })
    ]);

    // Category-wise breakdown
    const categoryBreakdown = await ProcedureRequest.aggregate([
      { $match: { hospitalId } },
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