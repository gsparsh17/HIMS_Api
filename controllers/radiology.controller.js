const { operationNow } = require('../utils/operationTimeContext');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const RadiologyRequest = require('../models/RadiologyRequest');
const DomainEvent = require('../models/DomainEvent');
const crypto = require('crypto');
const ImagingTest = require('../models/ImagingTest');
const RadiologyStaff = require('../models/RadiologyStaff');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const fileStorage = require('../services/fileStorage.service');
const fs = require('fs');
const { requireHospitalId } = require('../services/tenantScope.service');
const { postProviderJson } = require('../utils/functionalDomain');
const { resolveRequestPayerContext, rememberRequestPayerContextUsage } = require('../services/requestPayerContext.service');
const { postSourceCharge, reverseSourceFinancials } = require('../services/chargePosting.service');
const { assertAdmissionOpenForMutation } = require('../services/ipdLifecycleGuard.service');
const radiologyWorkflow = require('../services/radiologyWorkflow.service');
const { generateRadiologyReportPdf } = require('../services/radiologyPdf.service');
const { getHospitalPrintIdentity } = require('../services/hospitalPrintIdentity.service');


const safeUnlink = (filePath) => {
  if (!filePath) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
};

const hasValidReportSignature = (file) => {
  if (!file?.path) return false;
  const fd = fs.openSync(file.path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (file.mimetype === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    if (file.mimetype === 'image/png') return buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (['image/jpeg', 'image/jpg'].includes(file.mimetype)) return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return false;
  } finally {
    fs.closeSync(fd);
  }
};

// File uploads use the configured HIMS storage driver.


// ============== IMAGING TEST MASTER CRUD ==============

// Create imaging test
exports.createImagingTest = async (req, res) => {
  try {
    const {
      code, name, category, description, preparation_instructions,
      contraindications, contrast_required, contrast_details,
      turnaround_time_hours, base_price, insurance_coverage, is_active, template_only, is_billable, allow_zero_price, canonical_test_id
    } = req.body;

    if (!code || !name || !category) {
      return res.status(400).json({ success: false, code: 'IMAGING_TEST_VALIDATION_FAILED', error: 'Code, name, and category are required', fields: ['code', 'name', 'category'] });
    }
    const numericPrice = Number(base_price ?? 0);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      return res.status(400).json({ success: false, code: 'IMAGING_TEST_PRICE_INVALID', error: 'Base price must be a non-negative number', field: 'base_price' });
    }
    if (!Boolean(template_only) && (is_billable === undefined || Boolean(is_billable)) && numericPrice === 0 && !Boolean(allow_zero_price)) {
      return res.status(422).json({
        success: false,
        code: 'IMAGING_TEST_PRICE_REQUIRED',
        error: 'Active billable imaging tests require a positive cash price. Set allow_zero_price=true only for an explicitly approved zero-price service.',
        field: 'base_price'
      });
    }

    const hospitalId = requireHospitalId(req);
    const existing = await ImagingTest.findOne({ hospitalId, code: code.toUpperCase() });
    if (existing) {
      return res.status(409).json({ success: false, code: 'IMAGING_TEST_CODE_EXISTS', error: 'Imaging test with this code already exists', field: 'code' });
    }

    const imagingTest = new ImagingTest({
      hospitalId,
      code: code.toUpperCase(),
      name: name.trim(),
      category,
      description: description || '',
      preparation_instructions: preparation_instructions || '',
      contraindications: contraindications || '',
      contrast_required: contrast_required || false,
      contrast_details: contrast_details || '',
      turnaround_time_hours: turnaround_time_hours || 24,
      base_price: numericPrice,
      insurance_coverage: insurance_coverage || 'Partial',
      template_only: Boolean(template_only), is_billable: is_billable === undefined ? !template_only : Boolean(is_billable),
      allow_zero_price: Boolean(allow_zero_price), canonical_test_id: canonical_test_id || undefined,
      is_active: is_active !== undefined ? is_active : true,
      createdBy: req.user?._id
    });

    await imagingTest.save();
    res.status(201).json({ success: true, data: imagingTest });
  } catch (error) {
    console.error('Error creating imaging test:', error);
    const status = ['ValidationError','CastError'].includes(error?.name) ? 400 : 500;
    const fields = error?.errors ? Object.fromEntries(Object.entries(error.errors).map(([field, issue]) => [field, issue.message])) : undefined;
    res.status(status).json({ success: false, code: error?.name === 'ValidationError' ? 'IMAGING_TEST_VALIDATION_FAILED' : 'IMAGING_TEST_CREATE_FAILED', error: error.message, fields });
  }
};

// Compact active-test options used by the request-creation modal. Keeping this
// separate from the master-data listing avoids downloading hundreds of fields
// and prevents the worklist page from loading imaging masters until needed.
exports.getImagingTestOptions = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const tests = await ImagingTest.find({
      hospitalId,
      is_active: true,
      template_only: false,
      is_billable: true
    })
      .select('_id code name category base_price')
      .sort({ name: 1 })
      .lean();

    return res.json({ success: true, data: tests });
  } catch (error) {
    console.error('Error fetching imaging test options:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Get all imaging tests
exports.getImagingTests = async (req, res) => {
  try {
    const { active_only = 'true', category, search } = req.query;
    const filter = { hospitalId: requireHospitalId(req) };
    
    if (active_only === 'true') filter.is_active = true;
    if (req.query.status === 'active') filter.is_active = true;
    if (req.query.status === 'inactive') filter.is_active = false;
    if (req.query.include_template_only !== 'true') filter.template_only = false;
    if (req.query.include_non_billable !== 'true') filter.is_billable = true;
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } }
      ];
    }
    
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const [tests, total] = await Promise.all([
      ImagingTest.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ImagingTest.countDocuments(filter)
    ]);
    res.json({ success: true, data: tests, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('Error fetching imaging tests:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getImagingTestSummary = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const baseMatch = { hospitalId, template_only: { $ne: true }, is_billable: true };
    const [overallRows, categoryRows] = await Promise.all([
      ImagingTest.aggregate([
        { $match: baseMatch },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $ne: ['$is_active', false] }, 1, 0] } },
          estimatedUtilizationValue: { $sum: { $multiply: [{ $ifNull: ['$base_price', 0] }, { $ifNull: ['$usage_count', 0] }] } }
        } }
      ]),
      ImagingTest.aggregate([
        { $match: baseMatch },
        { $group: {
          _id: { $ifNull: ['$category', 'Other'] },
          count: { $sum: 1 },
          activeCount: { $sum: { $cond: [{ $ne: ['$is_active', false] }, 1, 0] } },
          usageCount: { $sum: { $ifNull: ['$usage_count', 0] } },
          estimatedUtilizationValue: { $sum: { $multiply: [{ $ifNull: ['$base_price', 0] }, { $ifNull: ['$usage_count', 0] }] } },
          priceTotal: { $sum: { $ifNull: ['$base_price', 0] } }
        } },
        { $project: {
          _id: 0,
          name: '$_id',
          count: 1,
          activeCount: 1,
          usageCount: 1,
          estimatedUtilizationValue: 1,
          avgPrice: { $cond: [{ $gt: ['$count', 0] }, { $divide: ['$priceTotal', '$count'] }, 0] }
        } },
        { $sort: { count: -1, name: 1 } }
      ])
    ]);
    const overall = overallRows[0] || { total: 0, active: 0, estimatedUtilizationValue: 0 };
    const categoryStats = categoryRows.map((row) => ({ ...row, name: String(row.name || 'Other').trim() || 'Other' }));
    return res.json({ success: true, data: {
      total: overall.total || 0,
      active: overall.active || 0,
      categories: Object.fromEntries(categoryStats.map((row) => [row.name, row.count])),
      categoryStats,
      estimatedUtilizationValue: overall.estimatedUtilizationValue || 0
    } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.bulkMoveImagingTestCategory = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const fromCategory = String(req.body?.fromCategory || '').trim();
    const toCategory = String(req.body?.toCategory || '').trim();
    if (!fromCategory || !toCategory) {
      return res.status(400).json({ success: false, error: 'fromCategory and toCategory are required' });
    }
    const result = await ImagingTest.updateMany(
      { hospitalId, category: fromCategory, template_only: { $ne: true }, is_billable: true },
      { $set: { category: toCategory, updatedBy: req.user?._id } }
    );
    return res.json({ success: true, modifiedCount: result.modifiedCount || 0, fromCategory, toCategory });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Update imaging test
exports.updateImagingTest = async (req, res) => {
  try {
    const { id } = req.params;
    const hospitalId = requireHospitalId(req);
    const current = await ImagingTest.findOne({ _id: id, hospitalId });
    if (!current) return res.status(404).json({ error: 'Orderable billable imaging test not found' });
    const updates = { ...req.body, updatedBy: req.user?._id };
    delete updates.hospitalId;
    if (updates.base_price !== undefined && Number(updates.base_price) !== Number(current.base_price)) {
      current.priceHistory.push({ amount: Number(current.base_price || 0), effectiveFrom: current.updatedAt || current.createdAt, effectiveTo: new Date(), reason: updates.price_change_reason || 'Imaging master edit', changedBy: req.user?._id });
    }
    delete updates.price_change_reason;
    current.set(updates);
    await current.save();
    const test = current;
    if (!test) return res.status(404).json({ error: 'Imaging test not found' });
    res.json({ success: true, data: test });
  } catch (error) {
    console.error('Error updating imaging test:', error);
    const status = ['ValidationError','CastError'].includes(error?.name) ? 400 : 500;
    const fields = error?.errors ? Object.fromEntries(Object.entries(error.errors).map(([field, issue]) => [field, issue.message])) : undefined;
    res.status(status).json({ success: false, code: error?.name === 'ValidationError' ? 'IMAGING_TEST_VALIDATION_FAILED' : 'IMAGING_TEST_UPDATE_FAILED', error: error.message, fields });
  }
};

// Delete imaging test
exports.deleteImagingTest = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ImagingTest.findOneAndUpdate(
      { _id: id, hospitalId: requireHospitalId(req), is_active: { $ne: false } },
      { $set: { is_active: false, is_billable: false, updatedBy: req.user?._id, deleted_at: new Date(), deleted_by: req.user?._id || null, deletion_reason: String(req.body?.reason || 'Imaging test archived by user').trim() } },
      { new: true }
    );
    if (!deleted) return res.status(404).json({ error: 'Imaging test not found' });
    res.json({ success: true, message: 'Imaging test archived successfully', data: deleted });
  } catch (error) {
    console.error('Error deleting imaging test:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============== RADIOLOGY REQUEST CRUD ==============

// Create radiology request (from IPD/OPD)
exports.createRadiologyRequest = async (req, res) => {
  try {
    const {
      sourceType, admissionId, appointmentId, prescriptionId, patientId, doctorId,
      imagingTestId, clinical_indication, clinical_history,
      priority, scheduledDate, patient_notes, coverage
    } = req.body;

    // Validate required fields
    if (!patientId || !doctorId || !imagingTestId) {
      return res.status(400).json({ error: 'Patient, doctor, and imaging test are required' });
    }

    // Get imaging test details
    const hospitalId = requireHospitalId(req);
    const imagingTest = await ImagingTest.findOne({ _id: imagingTestId, hospitalId, is_active: true, is_billable: true, template_only: false });
    if (!imagingTest) {
      return res.status(404).json({ error: 'Imaging test not found' });
    }

    // If source is IPD, validate admission
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
    await imagingTest.incrementUsage();

    const payerContext = await resolveRequestPayerContext({
      hospitalId,
      patientId,
      sourceType: sourceType || 'IPD',
      admissionId,
      appointmentId,
      declaredCoverage: coverage,
      userId: req.user?._id,
      rememberSource: 'RADIOLOGY'
    });

    const request = new RadiologyRequest({
      hospitalId,
      sourceType: sourceType || 'IPD',
      admissionId: admissionId || null,
      appointmentId: appointmentId || null,
      prescriptionId: prescriptionId || null,
      patientId,
      doctorId,
      imagingTestId,
      testCode: imagingTest.code,
      testName: imagingTest.name,
      category: imagingTest.category,
      reportTemplateId: imagingTest.report_template_id || '',
      reportTemplateName: imagingTest.report_template_name || '',
      clinical_indication: clinical_indication || '',
      clinical_history: clinical_history || '',
      priority: priority || 'Routine',
      scheduledDate: scheduledDate || null,
      patient_notes: patient_notes || '',
      cost: imagingTest.base_price,
      payerContext: payerContext || undefined,
      createdBy: req.user?._id
    });

    await request.save();
    await rememberRequestPayerContextUsage({
      hospitalId,
      patientId,
      payerContext,
      source: 'RADIOLOGY',
      encounterId: admissionId || appointmentId || request._id,
      userId: req.user?._id,
      usedAt: request.createdAt || operationNow()
    });

    // Automatic source finance for RadiologyRequest: creating the clinical request creates/reuses
    // the authoritative obligation. Pricing/clearance failures do not delete the clinical
    // order; the request remains PENDING_CHARGE and can be resumed from Front Desk/Finance.
    let financial = null;
    let financialWarning = null;
    if ((request.sourceType === 'IPD' && request.admissionId) || (request.sourceType === 'OPD' && request.appointmentId)) {
      try {
        financial = await postSourceCharge({
          sourceModule: 'RadiologyRequest',
          sourceId: request._id,
          idempotencyKey: `RadiologyRequest:${request._id}:charge`,
          user: req.user
        });
      } catch (financeError) {
        financialWarning = { code: financeError.code || 'SOURCE_FINANCE_PENDING', message: financeError.message };
        console.warn('RadiologyRequest automatic source-finance pending:', financeError.message);
      }
    }

    // Populate response
    const populated = await RadiologyRequest.findOne({ _id: request._id, hospitalId })
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category report_template_id report_template_name');

    res.status(201).json({ success: true, data: populated, financial: financial ? { chargeId: financial.charge?._id || null, billId: financial.bill?._id || null, invoiceId: financial.invoice?._id || null, financialPolicy: financial.financialPolicy || null } : null, financialWarning });
  } catch (error) {
    console.error('Error creating radiology request:', error);
    const status = Number(error?.statusCode || (['ValidationError', 'CastError'].includes(error?.name) ? 400 : 500));
    res.status(status).json({ error: error.code || error.message, message: error.message, code: error.code });
  }
};

// Get radiology requests (with filters)
exports.getRadiologyRequests = async (req, res) => {
  try {
    const {
      status, patientId, doctorId, admissionId, sourceType,
      startDate, endDate, page = 1, limit = 20
    } = req.query;

    const filter = { hospitalId: requireHospitalId(req) };
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (sourceType) filter.sourceType = sourceType;
    
    if (startDate || endDate) {
      filter.requestedDate = semanticDateRange(startDate, endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const requests = await RadiologyRequest.find(filter)
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category base_price report_template_id report_template_name')
      .populate('approvedBy', 'designation employeeId')
      .populate('performedBy', 'designation employeeId')
      .populate('reportedBy', 'designation employeeId')
      .sort({ requestedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await RadiologyRequest.countDocuments(filter);

    res.json({
      success: true,
      data: requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching radiology requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get radiology request by ID
exports.getRadiologyRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await RadiologyRequest.findOne({ _id: id, hospitalId: requireHospitalId(req) })
      .populate('patientId', 'first_name last_name patientId phone dob gender')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category base_price preparation_instructions report_template_id report_template_name')
      .populate('approvedBy', 'designation employeeId')
      .populate('performedBy', 'designation employeeId')
      .populate('reportedBy', 'designation employeeId');

    if (!request) {
      return res.status(404).json({ error: 'Radiology request not found' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching radiology request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update radiology request status. This compatibility endpoint is kept for older
// screens, but all transitions now go through the same audited state machine as
// the canonical schedule/start/results/verify/release endpoints.
exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });
    if (status === 'Cancelled' && !String(notes || '').trim()) {
      return res.status(400).json({ error: 'Cancellation reason is required so the financial reversal is auditable' });
    }
    if (status === 'Completed') {
      return res.status(409).json({
        error: 'Completed is a legacy radiology status. Enter results instead.',
        code: 'RADIOLOGY_LEGACY_STATUS_UNSUPPORTED',
        nextStatus: 'Result Entered'
      });
    }
    if (status === 'Reported') {
      return res.status(409).json({
        error: 'Radiology reports must be verified and released through the release endpoint.',
        code: 'RADIOLOGY_RELEASE_ENDPOINT_REQUIRED'
      });
    }

    const hospitalId = requireHospitalId(req);
    const request = await RadiologyRequest.findOne({ _id: id, hospitalId });
    if (!request) return res.status(404).json({ error: 'Radiology request not found' });
    if (request.reportFinalisation?.isFinal) {
      return res.status(409).json({ error: 'Final reports are immutable. Use the controlled amendment action.' });
    }

    const patch = {};
    if (status === 'In Progress' && notes) patch.technician_notes = notes;
    if (status === 'Verified' && notes) patch.radiologist_notes = notes;
    if (status === 'Cancelled') {
      patch.cancelledAt = operationNow();
      patch.cancelledBy = req.user?._id;
      patch.cancellationReason = String(notes || '').trim();
    }

    const data = await radiologyWorkflow.transition({
      req, request, to: status, hospitalId, note: notes, patch
    });

    let financialReversal = null;
    let financialWarning = null;
    if (status === 'Cancelled') {
      try {
        financialReversal = await reverseSourceFinancials({
          sourceModule: 'RadiologyRequest', sourceId: request._id, reason: notes, user: req.user
        });
      } catch (financeError) {
        financialWarning = financeError.message;
        console.warn('RadiologyRequest cancellation financial reversal pending:', financeError.message);
      }
    }

    return res.json({ success: true, message: `Request status updated to ${status}`, data, financialReversal, financialWarning });
  } catch (error) {
    console.error('Error updating radiology request status:', error);
    const statusCode = Number(error?.statusCode || 500);
    return res.status(statusCode).json({ error: error.message, code: error.code });
  }
};

// Upload radiology report
exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { findings, impression } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!hasValidReportSignature(req.file)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'The uploaded report content does not match a valid PDF, JPG, or PNG file.' });
    }

    const request = await RadiologyRequest.findOne({ _id: id, hospitalId: requireHospitalId(req) });
    if (!request) {
      safeUnlink(req.file.path);
      return res.status(404).json({ error: 'Radiology request not found' });
    }
    if (request.reportFinalisation?.isFinal) {
      safeUnlink(req.file.path);
      return res.status(409).json({ error: 'Final reports are immutable. Use the controlled amendment action.' });
    }

    const hospitalId = requireHospitalId(req);
    if (!['In Progress', 'Result Entered', 'Verified', 'Amended'].includes(request.status)) {
      safeUnlink(req.file.path);
      return res.status(409).json({
        error: 'A radiology report can only be uploaded after the study has started.',
        code: 'RADIOLOGY_REPORT_UPLOAD_STATE_INVALID',
        status: request.status
      });
    }

    // Validate workflow eligibility before durable storage. Otherwise an invalid
    // state request can upload a file and then return 409, leaving an orphan.
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';

    const result = await fileStorage.upload(req.file, req, {
      folder: 'radiology_reports',
      resource_type: resourceType,
      public_id: `rad_${request.requestNumber}_${Date.now()}`,
      access_mode: 'public'
    });

    safeUnlink(req.file.path);

    request.findings = findings || '';
    request.impression = impression || '';
    request.report_url = result.secure_url;
    request.public_id = result.public_id;
    request.report_mode = 'uploaded';
    request.report_file_name = req.file.originalname;
    request.report_mime_type = req.file.mimetype;
    request.report_file_size = req.file.size;
    request.manual_report = undefined;

    // Uploading/replacing report content never releases it. If verified content is
    // changed, invalidate that verification and require a fresh verify/release.
    if (request.status === 'In Progress' || request.status === 'Verified') {
      await radiologyWorkflow.transition({
        req,
        request,
        to: 'Result Entered',
        hospitalId,
        note: request.status === 'Verified' ? 'Report file changed after verification; re-verification required' : 'Report file uploaded'
      });
    } else {
      await request.save();
    }

    res.json({
      success: true,
      message: 'Report uploaded. Verification and release are still required.',
      report_url: result.secure_url,
      status: request.status
    });
  } catch (error) {
    console.error('Error uploading report:', error);
    safeUnlink(req.file?.path);
    res.status(500).json({ error: error.message });
  }
};

// Download report
exports.downloadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await RadiologyRequest.findOne({ _id: id, hospitalId: requireHospitalId(req) })
      .populate('patientId')
      .populate('doctorId')
      .populate('performedBy', 'name designation employeeId')
      .populate('reportedBy', 'name designation employeeId')
      .populate('admissionId', 'admissionNumber hospitalId')
      .populate('appointmentId', 'token')
      .populate({ path: 'prescriptionId', select: 'appointment_id', populate: { path: 'appointment_id', select: 'token' } });

    if (!request) return res.status(404).json({ error: 'Report not found' });
    if (request.report_url) return res.redirect(request.report_url);

    if (request.manual_report || request.findings || request.impression || request.recommendations) {
      const hospital = await getHospitalPrintIdentity({ includeLogoBuffer: true });
      return generateRadiologyReportPdf({ request, hospital, res });
    }

    return res.status(404).json({ error: 'Report not found' });
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============== ADMISSION-BASED QUERIES ==============

// Get radiology requests by admission (for IPD patient file)
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    if (!admissionId) {
      return res.status(400).json({ error: 'Admission ID is required' });
    }
    
    const requests = await RadiologyRequest.find({ 
      hospitalId: requireHospitalId(req),
      admissionId, 
      sourceType: 'IPD' 
    })
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category base_price report_template_id report_template_name')
      .populate('performedBy', 'name')
      .populate('reportedBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching radiology requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get pending radiology requests for IPD admission
exports.getPendingIPDRequests = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    if (!admissionId) {
      return res.status(400).json({ error: 'Admission ID is required' });
    }
    
    const requests = await RadiologyRequest.find({
      hospitalId: requireHospitalId(req),
      admissionId,
      sourceType: 'IPD',
      status: { $in: ['Pending', 'Approved', 'Scheduled'] }
    })
      .populate('imagingTestId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .sort({ priority: -1, requestedDate: 1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching pending IPD radiology requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get radiology requests by patient
exports.getRequestsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    
    if (!patientId) {
      return res.status(400).json({ error: 'Patient ID is required' });
    }
    
    const requests = await RadiologyRequest.find({ hospitalId: requireHospitalId(req), patientId })
      .populate('imagingTestId', 'code name category')
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
    
    const request = await RadiologyRequest.findOneAndUpdate(
      { _id: id, hospitalId: requireHospitalId(req) },
      { is_billed: true, invoiceId },
      { new: true }
    );
    
    if (!request) {
      return res.status(404).json({ error: 'Radiology request not found' });
    }
    
    res.json({ success: true, message: 'Request marked as billed', data: request });
  } catch (error) {
    console.error('Error marking as billed:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get dashboard stats for radiology
exports.getDashboardStats = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const today = operationNow();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [pending, todayScheduled, totalRequests, completedToday, reportedToday] = await Promise.all([
      RadiologyRequest.countDocuments({ hospitalId, status: 'Pending' }),
      RadiologyRequest.countDocuments({ 
        hospitalId,
        scheduledDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Scheduled', 'Approved'] }
      }),
      RadiologyRequest.countDocuments({ hospitalId }),
      RadiologyRequest.countDocuments({ 
        hospitalId,
        status: 'Completed',
        performedAt: { $gte: today, $lt: tomorrow }
      }),
      RadiologyRequest.countDocuments({ 
        hospitalId,
        status: 'Reported',
        reportedAt: { $gte: today, $lt: tomorrow }
      })
    ]);

    res.json({
      success: true,
      stats: {
        pending,
        todayScheduled,
        totalRequests,
        completedToday,
        reportedToday
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.referOut = async (req, res) => {
  try {
    const hospitalId = req.user?.hospital_id;
    const row = await RadiologyRequest.findOne({ _id: req.params.id, hospitalId }).populate('patientId','patientId uhid first_name last_name').populate('imagingTestId','code name');
    if (!row) return res.status(404).json({ error: 'Radiology request not found' });
    if (!req.body.facilityName) return res.status(400).json({ error: 'facilityName is required' });
    row.is_referred_out = true;
    row.external_facility = { name:req.body.facilityName,address:req.body.address,contact_person:req.body.contactPerson,contact_phone:req.body.contactPhone };
    row.external_reference_number = req.body.externalReferenceNumber || `EXT-RAD-${Date.now()}`;
    const providerUrl = process.env.EXTERNAL_RADIOLOGY_PROVIDER_URL || (process.env.NODE_ENV !== 'production' ? req.body.providerUrl : null);
    let provider = { configured: Boolean(providerUrl), delivered: false };
    if (providerUrl) {
      const result = await postProviderJson(providerUrl, {
        referenceNumber: row.external_reference_number,
        requestId: String(row._id),
        patient: { id: String(row.patientId?._id || row.patientId), patientId: row.patientId?.patientId, uhid: row.patientId?.uhid, name: [row.patientId?.first_name,row.patientId?.last_name].filter(Boolean).join(' ') },
        test: { id: String(row.imagingTestId?._id || row.imagingTestId), code: row.imagingTestId?.code, name: row.imagingTestId?.name },
        priority: row.priority,
        clinicalNotes: row.clinicalNotes
      }, { label:'External radiology provider', allowedHosts:process.env.EXTERNAL_RADIOLOGY_ALLOWED_HOSTS, headers:process.env.EXTERNAL_RADIOLOGY_API_KEY?{Authorization:`Bearer ${process.env.EXTERNAL_RADIOLOGY_API_KEY}`}:{}});
      provider = { configured:true, delivered:true, response:result };
    }
    row.external_exchange = { ...(row.external_exchange?.toObject?.()||row.external_exchange||{}), status:'sent', sentAt:operationNow(), payloadReference:req.body.payloadReference||row.external_reference_number };
    await row.save({ validateBeforeSave:false });
    await DomainEvent.create({eventId:`EVT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,eventType:'external_radiology_order_sent',hospitalId,patientId:row.patientId?._id||row.patientId,actorUserId:req.user._id,actorRole:req.user.role,entityType:'RadiologyRequest',entityId:row._id,correlationId:row.external_reference_number,afterSummary:{facility:row.external_facility,status:row.external_exchange.status,providerDelivered:provider.delivered}});
    return res.json({ success:true, data:row, provider });
  } catch (e) { return res.status(e.statusCode || 400).json({ error:e.message, details:e.details }); }
};
exports.receiveExternalResult = async (req,res) => {
  try {
    const hospitalId=req.user?.hospital_id; const row=await RadiologyRequest.findOne({_id:req.params.id,hospitalId,is_referred_out:true}); if(!row)return res.status(404).json({error:'Referred radiology request not found'});
    if(!req.body.reportUrl && !req.body.resultSummary)return res.status(400).json({error:'reportUrl or resultSummary is required'});
    row.external_report_url=req.body.reportUrl||row.external_report_url; row.result_description=req.body.resultSummary||row.result_description; row.external_exchange={...(row.external_exchange?.toObject?.()||row.external_exchange||{}),status:'result_received',resultReceivedAt:operationNow(),payloadReference:req.body.payloadReference||row.external_reference_number}; await row.save({validateBeforeSave:false});
    await DomainEvent.create({eventId:`EVT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,eventType:'external_radiology_result_received',hospitalId,patientId:row.patientId,actorUserId:req.user._id,actorRole:req.user.role,entityType:'RadiologyRequest',entityId:row._id,correlationId:row.external_reference_number,afterSummary:{reportUrl:row.external_report_url,status:row.external_exchange.status}});
    return res.json({success:true,data:row});
  } catch(e){return res.status(400).json({error:e.message});}
};
