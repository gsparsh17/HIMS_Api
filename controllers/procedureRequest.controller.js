const { operationNow } = require('../utils/operationTimeContext');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const ProcedureRequest = require('../models/ProcedureRequest');
const Procedure = require('../models/Procedure');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const IPDAdmission = require('../models/IPDAdmission');
const fileStorage = require('../services/fileStorage.service');
const fs = require('fs');
const { requireHospitalId } = require('../services/tenantScope.service');
const { resolveRequestPayerContext, rememberRequestPayerContextUsage } = require('../services/requestPayerContext.service');
const { postSourceCharge, getSourceFinancialStatus, reverseSourceFinancials } = require('../services/chargePosting.service');
const { assertAdmissionOpenForMutation } = require('../services/ipdLifecycleGuard.service');
const { requiresOtWorkflow, financialCanProceed } = require('../services/procedureWorkflow.service');




const PROCEDURE_STATUS_TRANSITIONS = Object.freeze({
  Pending: ['Approved', 'Cancelled'],
  Approved: ['Scheduled', 'In Progress', 'Cancelled', 'Postponed'],
  Scheduled: ['In Progress', 'Cancelled', 'Postponed'],
  Postponed: ['Scheduled', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: []
});

const canTransitionProcedure = (from, to) =>
  from === to || (PROCEDURE_STATUS_TRANSITIONS[from] || []).includes(to);


async function resolveProcedureMaster(request, hospitalId) {
  if (!request?.procedureId) return null;
  return Procedure.findOne({ _id: request.procedureId, hospitalId }).select('code name category serviceDomain duration_minutes').lean();
}

async function ensureProcedureFinancialReady(request, user) {
  // Scheduling/starting is the recovery point for historical requests whose
  // automatic charge creation previously failed. postSourceCharge is idempotent,
  // so this safely creates or reuses the authoritative obligation.
  await postSourceCharge({
    sourceModule: 'ProcedureRequest',
    sourceId: request._id,
    idempotencyKey: `ProcedureRequest:${request._id}:charge`,
    user,
  });
  const status = await getSourceFinancialStatus({ sourceModule: 'ProcedureRequest', sourceId: request._id, user });
  if (!financialCanProceed(status.clearanceState)) {
    const error = new Error(`Financial clearance is required before the procedure can proceed (${status.clearanceState || 'PAYMENT_REQUIRED'})`);
    error.statusCode = 409;
    error.code = 'PROCEDURE_FINANCIAL_CLEARANCE_REQUIRED';
    error.details = {
      clearanceState: status.clearanceState,
      selectedMode: status.selectedMode,
      requiredNow: status.requiredNow,
      outstandingRequiredNow: status.outstandingRequiredNow,
      totalInvoiced: status.totalInvoiced,
      paidNow: status.paidNow,
    };
    throw error;
  }
  return status;
}

// ============== PROCEDURE REQUEST CRUD ==============


// Active tenant-scoped procedure categories used by the operational worklist.
// This replaces the frontend's stale hard-coded list and automatically exposes
// legitimate non-OT categories such as General Medicine.
exports.getProcedureCategories = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const categories = await Procedure.distinct('category', {
      hospitalId,
      is_active: { $ne: false },
      is_billable: { $ne: false }
    });
    const cleaned = categories
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return res.json({ success: true, data: cleaned, categories: cleaned });
  } catch (error) {
    console.error('Error fetching procedure categories:', error);
    return res.status(500).json({ error: error.message });
  }
};

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
    if (requiresOtWorkflow(procedure)) {
      return res.status(409).json({
        error: 'This service is classified as Surgery. Create an Operation Theatre request instead of a generic ProcedureRequest.',
        code: 'PROCEDURE_REQUIRES_OT_WORKFLOW',
        details: { procedureId: procedure._id, procedureCode: procedure.code, serviceDomain: procedure.serviceDomain }
      });
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
      .populate('assignedDoctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price serviceDomain duration_minutes');

    res.status(201).json({ success: true, data: populated, financial: financial ? { chargeId: financial.charge?._id || null, billId: financial.bill?._id || null, invoiceId: financial.invoice?._id || null, financialPolicy: financial.financialPolicy || null } : null, financialWarning });
  } catch (error) {
    console.error('Error creating procedure request:', error);
    const status = Number(error?.statusCode || (['ValidationError', 'CastError'].includes(error?.name) ? 400 : 500));
    res.status(status).json({ error: error.code || error.message, message: error.message, code: error.code });
  }
};

// Get procedure requests (with filters)
const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.getProcedureRequests = async (req, res) => {
  try {
    const {
      status,
      patientId,
      doctorId,
      admissionId,
      appointmentId,
      sourceType,
      category,
      billing,
      q,
      startDate,
      endDate,
      page = 1,
      limit = 50
    } = req.query;

    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (appointmentId) filter.appointmentId = appointmentId;
    if (sourceType) filter.sourceType = sourceType;
    if (category) filter.category = category;

    if (billing === 'billed') {
      filter.billingState = 'INVOICED';
    } else if (billing === 'pending') {
      filter.financialClearanceState = {
        $in: ['PAYMENT_REQUIRED', 'TPA_PENDING', 'AUTHORIZATION_REQUIRED', 'HOLD']
      };
    }

    if (startDate || endDate) {
      filter.requestedDate = semanticDateRange(startDate, endDate);
    }

    const trimmedQuery = String(q || '').trim();
    if (trimmedQuery) {
      const regex = new RegExp(escapeRegex(trimmedQuery), 'i');
      const [patientMatches, doctorMatches] = await Promise.all([
        Patient.find({
          hospitalId,
          $or: [
            { first_name: regex },
            { last_name: regex },
            { patientId: regex },
            { uhid: regex },
            { phone: regex }
          ]
        }).select('_id').limit(250).lean(),
        Doctor.find({
          hospitalId,
          $or: [
            { firstName: regex },
            { lastName: regex },
            { specialization: regex }
          ]
        }).select('_id').limit(250).lean()
      ]);

      const searchClauses = [
        { requestNumber: regex },
        { procedureCode: regex },
        { procedureName: regex },
        { category: regex },
        { subcategory: regex },
        { clinical_indication: regex },
        { clinical_history: regex }
      ];
      if (patientMatches.length) searchClauses.push({ patientId: { $in: patientMatches.map((row) => row._id) } });
      if (doctorMatches.length) searchClauses.push({ doctorId: { $in: doctorMatches.map((row) => row._id) } });
      filter.$or = searchClauses;
    }

    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const skip = (safePage - 1) * safeLimit;

    const [requests, total] = await Promise.all([
      ProcedureRequest.find(filter)
        .populate('patientId', 'first_name last_name patientId uhid phone')
        .populate('doctorId', 'firstName lastName specialization')
        .populate('assignedDoctorId', 'firstName lastName specialization')
        .populate('procedureId', 'code name category base_price serviceDomain duration_minutes')
        .populate('approvedBy', 'name')
        .populate('performedBy', 'name')
        .populate('performedDoctorId', 'firstName lastName specialization')
        .populate('completedBy', 'name')
        .sort({ requestedDate: -1, _id: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      ProcedureRequest.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: requests,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.max(1, Math.ceil(total / safeLimit))
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
      .populate('assignedDoctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price serviceDomain duration_minutes pre_procedure_instructions post_procedure_instructions')
      .populate('approvedBy', 'name')
      .populate('performedBy', 'name')
      .populate('performedDoctorId', 'firstName lastName specialization')
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
    const {
      status,
      notes,
      scheduledDate,
      scheduled_date,
      assignedDoctorId,
      assigned_doctor_id,
      performed_by
    } = req.body;
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
    if (!canTransitionProcedure(previousStatus, status)) {
      return res.status(409).json({
        error: `Invalid procedure status transition from ${previousStatus} to ${status}`,
        code: 'PROCEDURE_STATUS_TRANSITION_INVALID',
        allowed: PROCEDURE_STATUS_TRANSITIONS[previousStatus] || []
      });
    }

    let normalizedScheduledDate = null;
    let normalizedAssignedDoctorId = null;
    if (status === 'Scheduled') {
      const rawScheduledDate = scheduledDate || scheduled_date || request.scheduledDate;
      normalizedScheduledDate = rawScheduledDate ? new Date(rawScheduledDate) : null;
      if (!normalizedScheduledDate || Number.isNaN(normalizedScheduledDate.getTime())) {
        return res.status(400).json({
          error: 'A valid scheduled date/time is required before moving the procedure to Scheduled',
          code: 'PROCEDURE_SCHEDULE_DATE_REQUIRED'
        });
      }

      normalizedAssignedDoctorId = assignedDoctorId || assigned_doctor_id || performed_by || request.assignedDoctorId;
      if (!normalizedAssignedDoctorId) {
        return res.status(400).json({
          error: 'Assign a clinician before scheduling the procedure',
          code: 'PROCEDURE_ASSIGNED_CLINICIAN_REQUIRED'
        });
      }

      const assignedDoctor = await Doctor.findOne({
        _id: normalizedAssignedDoctorId,
        hospitalId,
        is_active: { $ne: false },
        deleted_at: null
      }).select('_id firstName lastName specialization').lean();
      if (!assignedDoctor) {
        return res.status(409).json({
          error: 'The selected clinician is not an active doctor in this hospital',
          code: 'PROCEDURE_ASSIGNED_CLINICIAN_INVALID'
        });
      }
    }

    let financial = null;
    if (['Scheduled', 'In Progress'].includes(status)) {
      const procedureMaster = await resolveProcedureMaster(request, hospitalId);
      if (requiresOtWorkflow(procedureMaster || {})) {
        return res.status(409).json({
          error: 'This service is classified as Surgery and must continue through the Operation Theatre workflow',
          code: 'PROCEDURE_REQUIRES_OT_WORKFLOW',
          details: {
            procedureId: request.procedureId,
            procedureCode: request.procedureCode,
            serviceDomain: procedureMaster?.serviceDomain || 'surgery',
            admissionId: request.admissionId,
          }
        });
      }
      try {
        financial = await ensureProcedureFinancialReady(request, req.user);
      } catch (financialError) {
        return res.status(financialError.statusCode || 409).json({
          error: financialError.message,
          code: financialError.code || 'PROCEDURE_FINANCIAL_CLEARANCE_REQUIRED',
          details: financialError.details || null,
        });
      }
    }

    request.status = status;

    if (status === 'Scheduled') {
      request.scheduledDate = normalizedScheduledDate;
      request.assignedDoctorId = normalizedAssignedDoctorId;
      request.scheduledBy = userId;
      request.scheduledAt = operationNow();
      if (notes !== undefined) request.surgeon_notes = String(notes || '').trim();
    }
    
    // Update timestamps based on status
    if (status === 'Approved' && previousStatus === 'Pending') {
      request.approvedBy = userId;
      request.approvedAt = operationNow();
    } else if (status === 'In Progress') {
      request.performedBy = userId;
      request.performedDoctorId = request.assignedDoctorId || request.performedDoctorId || null;
      request.performedAt = operationNow();
    } else if (status === 'Completed') {
      request.completedBy = userId;
      request.completedAt = operationNow();
    } else if (status === 'Cancelled') {
      request.cancelled_by = userId;
      request.cancelled_at = operationNow();
      request.cancellation_reason = notes;
    }

    if (notes && status !== 'Cancelled' && status !== 'Scheduled') {
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
      financial: financial ? {
        clearanceState: financial.clearanceState,
        selectedMode: financial.selectedMode,
        requiredNow: financial.requiredNow,
        outstandingRequiredNow: financial.outstandingRequiredNow,
        totalInvoiced: financial.totalInvoiced,
        paidNow: financial.paidNow,
      } : null,
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
    const { findings, complications, post_procedure_instructions, notes, performedDoctorId, performed_doctor_id, performed_by } = req.body;
    const hospitalId = requireHospitalId(req);

    const request = await ProcedureRequest.findOne({ _id: id, hospitalId });
    if (!request) {
      return res.status(404).json({ error: 'Procedure request not found' });
    }

    if (!['In Progress', 'Completed'].includes(request.status)) {
      return res.status(409).json({
        error: 'Procedure findings can only be finalized after the procedure has started',
        code: 'PROCEDURE_NOT_IN_PROGRESS'
      });
    }

    request.findings = findings || '';
    request.complications = complications || '';
    request.post_procedure_instructions = post_procedure_instructions || '';
    if (notes !== undefined) request.surgeon_notes = String(notes || '').trim();

    const clinicianId = performedDoctorId || performed_doctor_id || performed_by || request.performedDoctorId || request.assignedDoctorId;
    if (clinicianId) {
      const clinician = await Doctor.findOne({
        _id: clinicianId,
        hospitalId,
        is_active: { $ne: false },
        deleted_at: null
      }).select('_id').lean();
      if (!clinician) {
        return res.status(409).json({
          error: 'The selected performing clinician is not an active doctor in this hospital',
          code: 'PROCEDURE_PERFORMER_INVALID'
        });
      }
      request.performedDoctorId = clinician._id;
    }

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
      .populate('assignedDoctorId', 'firstName lastName specialization')
      .populate('procedureId', 'code name category base_price serviceDomain duration_minutes pre_procedure_instructions')
      .populate('performedBy', 'name')
      .populate('performedDoctorId', 'firstName lastName specialization')
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
      .populate('procedureId', 'code name category serviceDomain duration_minutes estimated_duration_minutes')
      .populate('doctorId', 'firstName lastName')
      .populate('assignedDoctorId', 'firstName lastName specialization')
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
      .populate('procedureId', 'code name category serviceDomain duration_minutes')
      .populate('doctorId', 'firstName lastName')
      .populate('assignedDoctorId', 'firstName lastName specialization')
      .populate('performedDoctorId', 'firstName lastName specialization')
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

    const [summaryRows, categoryBreakdown] = await Promise.all([
      ProcedureRequest.aggregate([
        { $match: { hospitalId } },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalPending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
            scheduled: { $sum: { $cond: [{ $eq: ['$status', 'Scheduled'] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] }, 1, 0] } },
            todayProcedures: {
              $sum: {
                $cond: [
                  { $and: [{ $gte: ['$scheduledDate', today] }, { $lt: ['$scheduledDate', tomorrow] }] },
                  1,
                  0
                ]
              }
            },
            completedToday: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'Completed'] },
                      { $gte: ['$completedAt', today] },
                      { $lt: ['$completedAt', tomorrow] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            pendingPayments: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$status', 'Cancelled'] },
                      { $in: ['$financialClearanceState', ['PAYMENT_REQUIRED', 'TPA_PENDING', 'AUTHORIZATION_REQUIRED', 'HOLD']] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            completedOperationalValue: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'Completed'] },
                  {
                    $convert: {
                      input: { $ifNull: ['$pricingSnapshot.amounts.contracted', '$pricingSnapshot.contractedAmount'] },
                      to: 'double',
                      onError: 0,
                      onNull: 0
                    }
                  },
                  0
                ]
              }
            }
          }
        }
      ]),
      ProcedureRequest.aggregate([
        { $match: { hospitalId } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    const summary = summaryRows[0] || {};
    res.json({
      success: true,
      stats: {
        totalRequests: Number(summary.totalRequests || 0),
        totalPending: Number(summary.totalPending || 0),
        scheduled: Number(summary.scheduled || 0),
        inProgress: Number(summary.inProgress || 0),
        todayProcedures: Number(summary.todayProcedures || 0),
        completedToday: Number(summary.completedToday || 0),
        pendingPayments: Number(summary.pendingPayments || 0),
        completedOperationalValue: Number(summary.completedOperationalValue || 0),
        categoryBreakdown
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};